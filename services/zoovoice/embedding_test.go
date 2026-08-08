package main

import (
	"context"
	"errors"
	"math/rand"
	"strings"
	"testing"
)

type stubRunner struct {
	stdout   string
	stderr   string
	err      error
	lastName string
	lastArgs []string
}

func (runner *stubRunner) Run(
	_ context.Context,
	name string,
	args ...string,
) (commandOutput, error) {
	runner.lastName = name
	runner.lastArgs = args
	return commandOutput{Stdout: runner.stdout, Stderr: runner.stderr}, runner.err
}

func embeddingTestAnimals() []availableAnimal {
	return []availableAnimal{
		{ID: "cat", LabelJA: "猫"},
		{ID: "dog", LabelJA: "犬"},
	}
}

func TestEmbeddingAssociatorSelectsRankedAnimal(t *testing.T) {
	runner := &stubRunner{stdout: `{"input":"にゃーと鳴いた","selected_animal":{"id":"cat","label_ja":"猫"},` +
		`"strategy":"embedding_profile","score":4.32,"debiased":true,` +
		`"candidates":[{"rank":1,"id":"cat","label_ja":"猫","score":4.32},` +
		`{"rank":2,"id":"dog","label_ja":"犬","score":3.06}]}`}
	associator, err := newEmbeddingAssociator(runner, "/usr/bin/python3", "/app/runner.py", "/app/model", "/app/artifacts", 2)
	if err != nil {
		t.Fatal(err)
	}

	selection, err := associator.Select(context.Background(), "にゃーと鳴いた", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}

	if selection.Species != "cat" {
		t.Fatalf("species = %q, want cat", selection.Species)
	}
	if selection.Strategy != strategyEmbedding {
		t.Fatalf("strategy = %q, want %q", selection.Strategy, strategyEmbedding)
	}
	if selection.Score == nil || selection.Score.Total != 4.32 {
		t.Fatalf("score = %+v, want total 4.32", selection.Score)
	}
	if runner.lastName != "/usr/bin/python3" {
		t.Fatalf("command = %q, want /usr/bin/python3", runner.lastName)
	}
	if !strings.Contains(strings.Join(runner.lastArgs, " "), "--text にゃーと鳴いた") {
		t.Fatalf("args missing text: %v", runner.lastArgs)
	}
}

func TestEmbeddingAssociatorSkipsUnavailableAnimals(t *testing.T) {
	// 音源が無い動物が1位でも、利用可能な動物から選び直す。
	runner := &stubRunner{stdout: `{"input":"森を歩いた","selected_animal":{"id":"owl","label_ja":"フクロウ"},` +
		`"strategy":"embedding_profile","score":3.0,"debiased":true,` +
		`"candidates":[{"rank":1,"id":"owl","label_ja":"フクロウ","score":3.0},` +
		`{"rank":2,"id":"dog","label_ja":"犬","score":2.5}]}`}
	associator, err := newEmbeddingAssociator(runner, "/usr/bin/python3", "/app/runner.py", "/app/model", "/app/artifacts", 2)
	if err != nil {
		t.Fatal(err)
	}

	selection, err := associator.Select(context.Background(), "森を歩いた", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}

	if selection.Species != "dog" {
		t.Fatalf("species = %q, want dog", selection.Species)
	}
}

func TestEmbeddingAssociatorFallsBackWhenNoCandidateIsAvailable(t *testing.T) {
	runner := &stubRunner{stdout: `{"input":"謎の入力","selected_animal":{"id":"owl","label_ja":"フクロウ"},` +
		`"strategy":"embedding_profile","score":1.0,"debiased":true,` +
		`"candidates":[{"rank":1,"id":"owl","label_ja":"フクロウ","score":1.0}]}`}
	associator, err := newEmbeddingAssociator(runner, "/usr/bin/python3", "/app/runner.py", "/app/model", "/app/artifacts", 2)
	if err != nil {
		t.Fatal(err)
	}

	selection, err := associator.Select(context.Background(), "謎の入力", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}

	if selection.Strategy != strategyRandom {
		t.Fatalf("strategy = %q, want %q", selection.Strategy, strategyRandom)
	}
	if selection.Species != "cat" && selection.Species != "dog" {
		t.Fatalf("species = %q, want an available animal", selection.Species)
	}
}

func TestEmbeddingAssociatorReturnsErrorOnRunnerFailure(t *testing.T) {
	runner := &stubRunner{err: errors.New("exit status 1"), stderr: "boom"}
	associator, err := newEmbeddingAssociator(runner, "/usr/bin/python3", "/app/runner.py", "/app/model", "/app/artifacts", 2)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := associator.Select(context.Background(), "入力", embeddingTestAnimals(), rand.New(rand.NewSource(1))); err == nil {
		t.Fatal("expected an error when the runner fails")
	}
}

func TestEmbeddingAssociatorRejectsInvalidConfiguration(t *testing.T) {
	runner := &stubRunner{}
	if _, err := newEmbeddingAssociator(runner, "", "/app/runner.py", "/app/model", "/app/artifacts", 2); err == nil {
		t.Fatal("expected an error when the python command is empty")
	}
	if _, err := newEmbeddingAssociator(runner, "/usr/bin/python3", "/app/runner.py", "/app/model", "/app/artifacts", 0); err == nil {
		t.Fatal("expected an error when threads is not positive")
	}
}
