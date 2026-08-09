package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"math/rand"
	"os"
	"os/exec"
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

func (runner trackingExecRunner) Run(ctx context.Context, name string, args ...string) (commandOutput, error) {
	if name == "ffmpeg" && slices.Contains(args, "16000") && strings.HasSuffix(args[len(args)-1], "asr.wav") {
		*runner.events = append(*runner.events, "asr_audio")
	}
	return execCommandRunner{}.Run(ctx, name, args...)
}

type fixedTranscriber struct {
	events     *[]string
	transcript string
	err        error
}

func (transcriber fixedTranscriber) Transcribe(context.Context, string) (string, error) {
	if transcriber.events != nil {
		*transcriber.events = append(*transcriber.events, "transcribe")
	}
	return transcriber.transcript, transcriber.err
}

type fixedAssociator struct {
	events    *[]string
	selection AnimalSelection
	err       error
}

type associatorFunc func(context.Context, string, []availableAnimal) (AnimalSelection, error)

func (function associatorFunc) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
) (AnimalSelection, error) {
	return function(ctx, transcript, animals)
}

func (associator fixedAssociator) Select(context.Context, string, []availableAnimal) (AnimalSelection, error) {
	if associator.events != nil {
		*associator.events = append(*associator.events, "associate")
	}
	return associator.selection, associator.err
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
		repositoryCatalog(t),
		trackingExecRunner{events: &events},
		fixedTranscriber{events: &events, transcript: "犬が公園を走っています"},
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
	if result.Transcript != "犬が公園を走っています" || result.SelectedAnimal.ID != "dog" ||
		result.AssociationReason != "犬が出てくるため" {
		t.Fatalf("result = %#v", result)
	}
	if len(result.Insertions) == 0 {
		t.Fatal("automatic arrangement produced no insertions")
	}
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
		repositoryCatalog(t),
		execCommandRunner{},
		fixedTranscriber{transcript: secretTranscript},
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
			associator: associatorFunc(func(ctx context.Context, _ string, _ []availableAnimal) (AnimalSelection, error) {
				<-ctx.Done()
				return AnimalSelection{}, fmt.Errorf("%s: %w", secretEvidence, ctx.Err())
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
				associator = associatorFunc(func(context.Context, string, []availableAnimal) (AnimalSelection, error) {
					cancel()
					return AnimalSelection{}, fmt.Errorf("%s: %w", secretEvidence, context.Canceled)
				})
			}
			var logs bytes.Buffer
			composer := newComposer(
				repositoryCatalog(t),
				execCommandRunner{},
				test.transcriber,
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

func repositoryCatalog(t *testing.T) *assetCatalog {
	t.Helper()
	catalog, err := loadLegacyCatalog("assets")
	if err != nil {
		t.Fatal(err)
	}
	return catalog
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
