package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type fixedCommandRunner struct {
	output commandOutput
	err    error
}

type trackingExecRunner struct {
	events *[]string
}

type durationOverrideRunner struct {
	sourceDuration     float64
	normalizedDuration float64
}

func (runner durationOverrideRunner) Run(ctx context.Context, name string, args ...string) (commandOutput, error) {
	if name == "ffprobe" {
		switch filepath.Base(args[len(args)-1]) {
		case "input.audio":
			return commandOutput{Stdout: fmt.Sprintf("%.3f\n", runner.sourceDuration)}, nil
		case "normalized.wav":
			return commandOutput{Stdout: fmt.Sprintf("%.3f\n", runner.normalizedDuration)}, nil
		}
	}
	return execCommandRunner{}.Run(ctx, name, args...)
}

func (runner trackingExecRunner) Run(ctx context.Context, name string, args ...string) (commandOutput, error) {
	if name == "ffmpeg" && slices.Contains(args, "16000") && strings.HasSuffix(args[len(args)-1], "asr.wav") {
		*runner.events = append(*runner.events, "asr_audio")
	}
	return execCommandRunner{}.Run(ctx, name, args...)
}

type fixedTranscriber struct {
	events     *[]string
	transcript string
	tokens     []TranscriptToken
	err        error
}

func (transcriber fixedTranscriber) Transcribe(context.Context, string) (Transcript, error) {
	if transcriber.events != nil {
		*transcriber.events = append(*transcriber.events, "transcribe")
	}
	return Transcript{Text: transcriber.transcript, Tokens: transcriber.tokens}, transcriber.err
}

type fixedAssociator struct {
	events     *[]string
	selection  AnimalSelection
	selections []AnimalSelection
	err        error
}

type associatorFunc func(context.Context, string, []availableAnimal, int) ([]AnimalSelection, error)

func (function associatorFunc) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
	count int,
) ([]AnimalSelection, error) {
	return function(ctx, transcript, animals, count)
}

// requestedCount は最後に要求された種類数。既定が1で渡ることを確かめるために記録する。
var requestedCount int

func (associator fixedAssociator) Select(
	_ context.Context,
	_ string,
	_ []availableAnimal,
	count int,
) ([]AnimalSelection, error) {
	if associator.events != nil {
		*associator.events = append(*associator.events, "associate")
	}
	requestedCount = count
	if associator.err != nil {
		return nil, associator.err
	}
	if associator.selections != nil {
		return associator.selections, nil
	}
	return []AnimalSelection{associator.selection}, nil
}

func TestComposerPipelineConvertsASRThenTranscribesAssociatesAndMixes(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := os.Stat("/usr/local/bin/" + binary); err != nil {
			// execCommandRunner resolves PATH; this check only avoids a hard dependency in minimal CI images.
			if _, err := os.Stat("/opt/homebrew/bin/" + binary); err != nil {
				t.Skipf("%s is unavailable", binary)
			}
		}
	}
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	events := []string{}
	composer := newComposer(
		fixtureCatalog(t),
		trackingExecRunner{events: &events},
		fixedTranscriber{
			events:     &events,
			transcript: pipelineTranscript,
			tokens:     evenTokens(pipelineTranscript, 0.2, 0.35),
		},
		newTestSegmenter(t),
		fixedAssociator{events: &events, selection: AnimalSelection{
			Species: "dog", LabelJA: "犬", Reason: "犬が出てくるため", Strategy: strategyLLM,
		}},
		rand.New(rand.NewSource(1)),
		30*time.Second,
		log.New(io.Discard, "", 0),
	)
	result, err := composer.Compose(context.Background(), input, ComposeSettings{Intensity: 50})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(events, ",") != "asr_audio,transcribe,associate" {
		t.Fatalf("pipeline events = %v", events)
	}
	if result.Transcript != pipelineTranscript || result.SelectedAnimal.ID != "dog" ||
		result.AssociationReason != "犬が出てくるため" {
		t.Fatalf("result = %#v", result)
	}
	// 文中の単語の切れ目と末尾の両方へ入る。差し込みなので出力は入力より長い。
	if len(result.Insertions) < 2 {
		t.Fatalf("insertions = %#v", result.Insertions)
	}
	if first := result.Insertions[0]; first.Slot != slotWord || first.AtSeconds <= 0 {
		t.Fatalf("first insertion = %+v", first)
	}
	if last := result.Insertions[len(result.Insertions)-1]; last.Slot != slotEnding {
		t.Fatalf("last insertion = %+v", last)
	}
	if result.OutputDurationSeconds <= result.InputDurationSeconds {
		t.Fatalf("output %.3f is not longer than input %.3f",
			result.OutputDurationSeconds, result.InputDurationSeconds)
	}
	insertedSeconds := 0.0
	for _, insertion := range result.Insertions {
		insertedSeconds += insertion.DurationSeconds
	}
	if durationDelta := result.OutputDurationSeconds - result.InputDurationSeconds; math.Abs(durationDelta-insertedSeconds) > 0.02 {
		t.Fatalf(
			"output delta %.3f does not match insertion metadata %.3f: %#v",
			durationDelta,
			insertedSeconds,
			result.Insertions,
		)
	}
	if strings.Join(result.Words, "|") != "犬|が|公園|を|走っ|て|い|ます" {
		t.Fatalf("words = %#v", result.Words)
	}
	// animal_count を省略した設定では1種を要求し、応答も1件になる。
	if requestedCount != 1 {
		t.Fatalf("requested animal count = %d", requestedCount)
	}
	if len(result.SelectedAnimals) != 1 || result.SelectedAnimals[0].ID != "dog" ||
		result.SelectedAnimals[0].Reason != result.AssociationReason {
		t.Fatalf("selected animals = %#v", result.SelectedAnimals)
	}
}

const pipelineTranscript = "犬が公園を走っています"

// evenTokens は1文字ずつへ等間隔の時刻を割り当てたASR結果を作る。
// testdata/compose-input.wav は4.7秒なので、時刻はその中へ収める。
func evenTokens(text string, startSeconds, stepSeconds float64) []TranscriptToken {
	tokens := make([]TranscriptToken, 0, len([]rune(text)))
	start := startSeconds
	for _, character := range text {
		tokens = append(tokens, TranscriptToken{
			Text:         string(character),
			StartSeconds: start,
			EndSeconds:   start + stepSeconds,
		})
		start += stepSeconds
	}
	return tokens
}

func TestComposerLogsNeverContainTranscriptOrReason(t *testing.T) {
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	secretTranscript := "秘密の猫"
	secretReason := "秘密の理由"
	composer := newComposer(
		fixtureCatalog(t),
		execCommandRunner{},
		fixedTranscriber{transcript: secretTranscript},
		newTestSegmenter(t),
		fixedAssociator{selection: AnimalSelection{
			Species: "cat", LabelJA: "猫", Reason: secretReason, Strategy: strategyLLM,
		}},
		rand.New(rand.NewSource(1)),
		30*time.Second,
		log.New(&logs, "", 0),
	)
	if _, err := composer.Compose(context.Background(), input, ComposeSettings{Intensity: 50}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logs.String(), secretTranscript) || strings.Contains(logs.String(), secretReason) {
		t.Fatalf("private ASR data leaked to logs: %s", logs.String())
	}
}

func TestComposerLogsNeverContainPrivateTextOnFailureTimeoutOrCancel(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skipf("%s is unavailable", binary)
		}
	}
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	const secretTranscript = "秘密の猫"
	const secretEvidence = "秘密の根拠"
	tests := []struct {
		name         string
		transcriber  transcriber
		associator   animalAssociator
		timeout      time.Duration
		context      func() (context.Context, context.CancelFunc)
		expectedCode string
	}{
		{
			name: "asr failure",
			transcriber: fixedTranscriber{
				err: errors.New(secretTranscript),
			},
			associator: fixedAssociator{}, timeout: 30 * time.Second,
			context: func() (context.Context, context.CancelFunc) {
				return context.WithCancel(context.Background())
			},
			expectedCode: "asr_failed",
		},
		{
			name:        "association failure",
			transcriber: fixedTranscriber{transcript: secretTranscript},
			associator: fixedAssociator{
				err: errors.New(secretEvidence),
			},
			timeout: 30 * time.Second,
			context: func() (context.Context, context.CancelFunc) {
				return context.WithCancel(context.Background())
			},
			expectedCode: "association_failed",
		},
		{
			name:        "timeout",
			transcriber: fixedTranscriber{transcript: secretTranscript},
			associator: associatorFunc(func(ctx context.Context, _ string, _ []availableAnimal, _ int) ([]AnimalSelection, error) {
				<-ctx.Done()
				return nil, fmt.Errorf("%s: %w", secretEvidence, ctx.Err())
			}),
			timeout: time.Second,
			context: func() (context.Context, context.CancelFunc) {
				return context.WithCancel(context.Background())
			},
			expectedCode: "processing_timeout",
		},
		{
			name:        "client cancel",
			transcriber: fixedTranscriber{transcript: secretTranscript},
			timeout:     30 * time.Second,
			context: func() (context.Context, context.CancelFunc) {
				return context.WithCancel(context.Background())
			},
			expectedCode: "processing_cancelled",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := test.context()
			defer cancel()
			associator := test.associator
			if test.name == "client cancel" {
				associator = associatorFunc(func(context.Context, string, []availableAnimal, int) ([]AnimalSelection, error) {
					cancel()
					return nil, fmt.Errorf("%s: %w", secretEvidence, context.Canceled)
				})
			}
			var logs bytes.Buffer
			composer := newComposer(
				fixtureCatalog(t),
				execCommandRunner{},
				test.transcriber,
				newTestSegmenter(t),
				associator,
				rand.New(rand.NewSource(1)),
				test.timeout,
				log.New(&logs, "", 0),
			)
			_, composeErr := composer.Compose(ctx, input, ComposeSettings{Intensity: 50})
			var apiError *APIError
			if !errors.As(composeErr, &apiError) || apiError.Code != test.expectedCode {
				t.Fatalf("error = %#v, want code %s", composeErr, test.expectedCode)
			}
			if strings.Contains(logs.String(), secretTranscript) || strings.Contains(logs.String(), secretEvidence) {
				t.Fatalf("private ASR data leaked to logs: %s", logs.String())
			}
		})
	}
}

func (runner fixedCommandRunner) Run(
	_ context.Context,
	_ string,
	_ ...string,
) (commandOutput, error) {
	return runner.output, runner.err
}

func TestProbeDurationAllowsBrowserMediaWithoutContainerDuration(t *testing.T) {
	composer := &composer{
		runner: fixedCommandRunner{output: commandOutput{Stdout: "N/A\n"}},
	}

	_, err := composer.probeDuration(context.Background(), "recording.webm")

	if !errors.Is(err, errDurationUnavailable) {
		t.Fatalf("error = %v, want errDurationUnavailable", err)
	}
}

func TestComposerUsesNormalizedDurationForInsertionDensity(t *testing.T) {
	requireMediaTools(t)
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	composer := newComposer(
		fixtureCatalog(t),
		durationOverrideRunner{sourceDuration: 5.999, normalizedDuration: 6.001},
		fixedTranscriber{
			transcript: pipelineTranscript,
			tokens:     evenTokens(pipelineTranscript, 0.2, 0.35),
		},
		newTestSegmenter(t),
		fixedAssociator{selection: AnimalSelection{
			Species: "dog", LabelJA: "犬", Reason: "犬だから", Strategy: strategyLLM,
		}},
		rand.New(rand.NewSource(1)),
		30*time.Second,
		log.New(io.Discard, "", 0),
	)

	result, err := composer.Compose(
		context.Background(), input, ComposeSettings{Intensity: 50, AnimalCount: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.InputDurationSeconds != 6.001 {
		t.Fatalf("input duration = %.3f, want normalized duration 6.001", result.InputDurationSeconds)
	}
	wordInsertions := 0
	for _, insertion := range result.Insertions {
		if insertion.Slot == slotWord {
			wordInsertions++
		}
	}
	if wordInsertions != 2 {
		t.Fatalf("word insertions = %d, want 2 from normalized duration: %#v", wordInsertions, result.Insertions)
	}
}

// animal_count=2 では2種が交互に入り、末尾は1件目になる。
func TestComposerAlternatesTwoAnimalsWhenRequested(t *testing.T) {
	requireMediaTools(t)
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	composer := newComposer(
		fixtureCatalog(t),
		execCommandRunner{},
		fixedTranscriber{
			transcript: pipelineTranscript,
			tokens:     evenTokens(pipelineTranscript, 0.2, 0.35),
		},
		newTestSegmenter(t),
		fixedAssociator{selections: []AnimalSelection{
			{Species: "dog", LabelJA: "犬", Reason: "犬だから", Strategy: strategyLLM},
			{Species: "cat", LabelJA: "猫", Reason: "猫だから", Strategy: strategyLLM},
		}},
		rand.New(rand.NewSource(1)),
		30*time.Second,
		log.New(io.Discard, "", 0),
	)
	result, err := composer.Compose(
		context.Background(), input, ComposeSettings{Intensity: 100, AnimalCount: 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	if requestedCount != 2 {
		t.Fatalf("requested animal count = %d", requestedCount)
	}
	if len(result.SelectedAnimals) != 2 {
		t.Fatalf("selected animals = %#v", result.SelectedAnimals)
	}
	if result.SelectedAnimal.ID != "dog" || result.AssociationReason != "犬だから" {
		t.Fatalf("primary animal = %#v reason = %q", result.SelectedAnimal, result.AssociationReason)
	}
	words := result.Insertions[:len(result.Insertions)-1]
	for index, insertion := range words {
		want := "dog"
		if index%2 == 1 {
			want = "cat"
		}
		if insertion.Species != want {
			t.Fatalf("insertion[%d] species = %q, want %q: %#v", index, insertion.Species, want, result.Insertions)
		}
	}
	if ending := result.Insertions[len(result.Insertions)-1]; ending.Species != "dog" {
		t.Fatalf("ending species = %q, want the first animal", ending.Species)
	}
}

func requireMediaTools(t *testing.T) {
	t.Helper()
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := os.Stat("/usr/local/bin/" + binary); err != nil {
			if _, err := os.Stat("/opt/homebrew/bin/" + binary); err != nil {
				t.Skipf("%s is unavailable", binary)
			}
		}
	}
}
