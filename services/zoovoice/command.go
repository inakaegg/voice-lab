package main

import (
	"bytes"
	"context"
	"os/exec"
)

type commandOutput struct {
	Stdout string
	Stderr string
}

type commandRunner interface {
	Run(ctx context.Context, name string, args ...string) (commandOutput, error)
}

type execCommandRunner struct{}

func (execCommandRunner) Run(
	ctx context.Context,
	name string,
	args ...string,
) (commandOutput, error) {
	command := exec.CommandContext(ctx, name, args...)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	return commandOutput{Stdout: stdout.String(), Stderr: stderr.String()}, err
}
