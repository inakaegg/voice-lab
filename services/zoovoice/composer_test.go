package main

import (
	"context"
	"errors"
	"testing"
)

type fixedCommandRunner struct {
	output commandOutput
	err    error
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
