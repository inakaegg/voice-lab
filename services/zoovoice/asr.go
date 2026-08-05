package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

var errASREmpty = errors.New("ASR transcript is empty")

type transcriber interface {
	Transcribe(context.Context, string) (string, error)
}

type whisperTranscriber struct {
	runner      commandRunner
	commandPath string
	modelPath   string
	threads     int
}

func newWhisperTranscriber(
	runner commandRunner,
	commandPath string,
	modelPath string,
	threads int,
) (*whisperTranscriber, error) {
	if !regularFileExists(commandPath) {
		return nil, fmt.Errorf("ZOOVOICE_WHISPER_COMMAND must be a regular file")
	}
	if !regularFileExists(modelPath) {
		return nil, fmt.Errorf("ZOOVOICE_ASR_MODEL_PATH must be a regular file")
	}
	if threads < 1 {
		return nil, fmt.Errorf("ASR threads must be positive")
	}
	return &whisperTranscriber{
		runner: runner, commandPath: commandPath, modelPath: modelPath, threads: threads,
	}, nil
}

func (transcriber *whisperTranscriber) Transcribe(ctx context.Context, wavPath string) (string, error) {
	output, err := transcriber.runner.Run(
		ctx,
		transcriber.commandPath,
		"-ng",
		"-np",
		"-m", transcriber.modelPath,
		"-l", "ja",
		"-nt",
		"-t", strconv.Itoa(transcriber.threads),
		"-f", wavPath,
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return "", ctxErr
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return "", err
		}
		return "", fmt.Errorf("whisper command failed: %w", err)
	}
	transcript := strings.TrimSpace(output.Stdout)
	if transcript == "" {
		return "", errASREmpty
	}
	return transcript, nil
}
