package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

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

func TestWhisperTranscriberUsesFixedJapaneseArgsAndTrimsOutput(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	runner := &recordingCommandRunner{output: commandOutput{Stdout: "  犬が公園を走っています。\n"}}
	transcriber, err := newWhisperTranscriber(runner, commandPath, modelPath, 2)
	if err != nil {
		t.Fatal(err)
	}
	transcript, err := transcriber.Transcribe(context.Background(), "/tmp/asr.wav")
	if err != nil {
		t.Fatal(err)
	}
	if transcript != "犬が公園を走っています。" {
		t.Fatalf("transcript = %q", transcript)
	}
	wantArgs := []string{"-ng", "-np", "-m", modelPath, "-l", "ja", "-nt", "-t", "2", "-f", "/tmp/asr.wav"}
	if runner.name != commandPath || !reflect.DeepEqual(runner.args, wantArgs) {
		t.Fatalf("command = %q %#v, want %q %#v", runner.name, runner.args, commandPath, wantArgs)
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
