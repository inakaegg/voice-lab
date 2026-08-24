package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"
)

// whisperMaxLenFixture は whisper-cli を -ml 1 で実際に走らせて得た標準出力。
// 「屋」と「泣」がbyte単位で2つのtokenへ割れており、1つずつではUTF-8として成立しない。
// 取得日 2026-08-22 / モデル ggml-small.bin / 入力は `say -v Kyoko` で作った日本語音声。
const whisperMaxLenFixture = "" +
	"\n" +
	"[00:00:00.000 --> 00:00:00.140]  \n" +
	"[00:00:00.140 --> 00:00:00.150]  昨\n" +
	"[00:00:00.150 --> 00:00:00.300]  日\n" +
	"[00:00:00.300 --> 00:00:00.450]  の\n" +
	"[00:00:00.450 --> 00:00:00.600]  夜\n" +
	"[00:00:00.600 --> 00:00:00.740]  、\n" +
	"[00:00:00.740 --> 00:00:00.850]  \xe5\xb1\n" +
	"[00:00:00.850 --> 00:00:01.050]  \x8b\n" +
	"[00:00:01.050 --> 00:00:01.090]  根\n" +
	"[00:00:01.090 --> 00:00:01.200]  の\n" +
	"[00:00:01.200 --> 00:00:01.350]  上\n" +
	"[00:00:01.350 --> 00:00:01.500]  で\n" +
	"[00:00:01.500 --> 00:00:01.650]  、\n" +
	"[00:00:01.650 --> 00:00:01.800]  何\n" +
	"[00:00:01.800 --> 00:00:01.970]  か\n" +
	"[00:00:01.970 --> 00:00:02.100]  が\n" +
	"[00:00:02.100 --> 00:00:02.280]  ず\n" +
	"[00:00:02.280 --> 00:00:02.570]  っと\n" +
	"[00:00:02.570 --> 00:00:02.650]  \xe6\xb3\n" +
	"[00:00:02.650 --> 00:00:02.870]  \xa3\n" +
	"[00:00:02.870 --> 00:00:03.000]  いて\n" +
	"[00:00:03.000 --> 00:00:03.610]  いました\n" +
	"[00:00:03.610 --> 00:00:03.840]  。\n"

const whisperFixtureTranscript = "昨日の夜、屋根の上で、何かがずっと泣いていました。"

type recordingCommandRunner struct {
	name   string
	args   []string
	output commandOutput
	err    error
}

func (runner *recordingCommandRunner) Run(
	_ context.Context,
	name string,
	args ...string,
) (commandOutput, error) {
	runner.name = name
	runner.args = append([]string{}, args...)
	return runner.output, runner.err
}

func TestWhisperTranscriberUsesTokenTimestampArgsAndParsesOutput(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	runner := &recordingCommandRunner{output: commandOutput{Stdout: whisperMaxLenFixture}}
	transcriber, err := newWhisperTranscriber(runner, commandPath, modelPath, 2)
	if err != nil {
		t.Fatal(err)
	}
	transcription, err := transcriber.Transcribe(context.Background(), "/tmp/asr.wav")
	if err != nil {
		t.Fatal(err)
	}
	if transcription.Text != whisperFixtureTranscript {
		t.Fatalf("transcript = %q", transcription.Text)
	}
	// -nt（時刻なし）ではtoken時刻を取れないため、-ml 1 へ変えている。
	wantArgs := []string{"-ng", "-np", "-m", modelPath, "-l", "ja", "-ml", "1", "-t", "2", "-f", "/tmp/asr.wav"}
	if runner.name != commandPath || !reflect.DeepEqual(runner.args, wantArgs) {
		t.Fatalf("command = %q %#v, want %q %#v", runner.name, runner.args, commandPath, wantArgs)
	}
}

// byte分割されたtokenを繋ぎ直せないと、文字化けしたテキストがLLMとAPI応答へ流れる。
func TestParseWhisperTranscriptRebuildsByteSplitTokens(t *testing.T) {
	transcription := parseWhisperTranscript(whisperMaxLenFixture)
	if !utf8.ValidString(transcription.Text) {
		t.Fatalf("transcript is not valid UTF-8: %q", transcription.Text)
	}
	joined := ""
	for _, token := range transcription.Tokens {
		if !utf8.ValidString(token.Text) {
			t.Fatalf("token is not valid UTF-8: %q", token.Text)
		}
		joined += token.Text
	}
	if joined != whisperFixtureTranscript {
		t.Fatalf("joined tokens = %q", joined)
	}
	byText := map[string]TranscriptToken{}
	for _, token := range transcription.Tokens {
		byText[token.Text] = token
	}
	// 「屋」は 0.740-0.850 と 0.850-1.050 の2断片。繋いだ後は端の時刻を引き継ぐ。
	rebuilt, ok := byText["屋"]
	if !ok {
		t.Fatalf("tokens = %#v", transcription.Tokens)
	}
	if rebuilt.StartSeconds != 0.740 || rebuilt.EndSeconds != 1.050 {
		t.Fatalf("屋 token = %+v", rebuilt)
	}
	if first := transcription.Tokens[0]; first.Text != "昨" || first.StartSeconds != 0.140 {
		t.Fatalf("first token = %+v", first)
	}
	if last := transcription.Tokens[len(transcription.Tokens)-1]; last.Text != "。" || last.EndSeconds != 3.840 {
		t.Fatalf("last token = %+v", last)
	}
}

func TestParseWhisperTranscriptSkipsUnparsableLines(t *testing.T) {
	stdout := "" +
		"whisper_init_from_file: loading model\n" +
		"[00:00:aa --> 00:00:01.000]  壊\n" +
		"[00:00:00.500 --> 00:00:01.000]  犬\n" +
		"[bad]  猫\n"
	transcription := parseWhisperTranscript(stdout)
	if transcription.Text != "犬" {
		t.Fatalf("transcript = %q tokens = %#v", transcription.Text, transcription.Tokens)
	}
}

func TestParseWhisperTimestampConvertsHoursAndMinutes(t *testing.T) {
	seconds, ok := parseWhisperTimestamp("01:02:03.500")
	if !ok || seconds != 3723.5 {
		t.Fatalf("seconds = %v ok = %v", seconds, ok)
	}
	if _, ok := parseWhisperTimestamp("00:01"); ok {
		t.Fatal("accepted a malformed timestamp")
	}
}

func TestWhisperTranscriberRejectsEmptyAndRedactsCommandOutput(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	for _, test := range []struct {
		name   string
		output commandOutput
		err    error
	}{
		{name: "empty", output: commandOutput{Stdout: " \n"}},
		{name: "silence only", output: commandOutput{Stdout: "[00:00:00.000 --> 00:00:01.000]  \n"}},
		{name: "command failure", output: commandOutput{Stdout: "秘密の猫", Stderr: "秘密の根拠"}, err: errors.New("exit 1")},
	} {
		t.Run(test.name, func(t *testing.T) {
			runner := &recordingCommandRunner{output: test.output, err: test.err}
			transcriber, err := newWhisperTranscriber(runner, commandPath, modelPath, 1)
			if err != nil {
				t.Fatal(err)
			}
			_, err = transcriber.Transcribe(context.Background(), "/tmp/asr.wav")
			if err == nil {
				t.Fatal("Transcribe succeeded")
			}
			if strings.Contains(err.Error(), "秘密") {
				t.Fatalf("command output leaked in error: %v", err)
			}
		})
	}
}

func TestWhisperTranscriberPreservesContextCancellation(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	runner := &recordingCommandRunner{err: context.Canceled}
	transcriber, err := newWhisperTranscriber(runner, commandPath, modelPath, 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = transcriber.Transcribe(context.Background(), "/tmp/asr.wav")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestNewWhisperTranscriberRequiresRegularFilesAndPositiveThreads(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	for _, test := range []struct {
		command string
		model   string
		threads int
	}{
		{command: filepath.Join(t.TempDir(), "missing"), model: modelPath, threads: 1},
		{command: commandPath, model: filepath.Join(t.TempDir(), "missing"), threads: 1},
		{command: commandPath, model: modelPath, threads: 0},
	} {
		if _, err := newWhisperTranscriber(&recordingCommandRunner{}, test.command, test.model, test.threads); err == nil {
			t.Errorf("accepted command=%q model=%q threads=%d", test.command, test.model, test.threads)
		}
	}
}

func createASRFiles(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	commandPath := filepath.Join(root, "whisper-cli")
	modelPath := filepath.Join(root, "model.bin")
	for _, path := range []string{commandPath, modelPath} {
		if err := os.WriteFile(path, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return commandPath, modelPath
}
