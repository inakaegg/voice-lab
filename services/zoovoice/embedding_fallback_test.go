package main

import (
	"context"
	"errors"
	"math/rand"
	"testing"
)

type stubAssociator struct {
	selection AnimalSelection
	err       error
	calls     int
}

func (associator *stubAssociator) Select(
	_ context.Context,
	_ string,
	_ []availableAnimal,
	_ *rand.Rand,
) (AnimalSelection, error) {
	associator.calls++
	return associator.selection, associator.err
}

func TestFallbackAssociatorKeepsDictionaryHit(t *testing.T) {
	primary := &stubAssociator{selection: AnimalSelection{Species: "cat", Strategy: strategyConceptNet}}
	embedding := &stubAssociator{selection: AnimalSelection{Species: "dog", Strategy: strategyEmbedding}}
	chain := &embeddingFallbackAssociator{primary: primary, embedding: embedding}

	selection, err := chain.Select(context.Background(), "猫の話", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "cat" || selection.Strategy != strategyConceptNet {
		t.Fatalf("selection = %+v, want conceptnet cat", selection)
	}
	if embedding.calls != 0 {
		t.Fatalf("embedding calls = %d, want 0", embedding.calls)
	}
}

func TestFallbackAssociatorUsesEmbeddingOnRandomFallback(t *testing.T) {
	primary := &stubAssociator{selection: AnimalSelection{Species: "cow", Strategy: strategyRandom, FallbackReason: "no_concept"}}
	embedding := &stubAssociator{selection: AnimalSelection{Species: "cat", Strategy: strategyEmbedding}}
	chain := &embeddingFallbackAssociator{primary: primary, embedding: embedding}

	selection, err := chain.Select(context.Background(), "にゃーと鳴いた", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "cat" || selection.Strategy != strategyEmbedding {
		t.Fatalf("selection = %+v, want embedding cat", selection)
	}
}

func TestFallbackAssociatorKeepsRandomWhenEmbeddingFails(t *testing.T) {
	primary := &stubAssociator{selection: AnimalSelection{Species: "cow", Strategy: strategyRandom, FallbackReason: "no_concept"}}
	embedding := &stubAssociator{err: errors.New("runner crashed")}
	chain := &embeddingFallbackAssociator{primary: primary, embedding: embedding}

	selection, err := chain.Select(context.Background(), "謎の入力", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "cow" || selection.Strategy != strategyRandom {
		t.Fatalf("selection = %+v, want primary random fallback", selection)
	}
}

func TestFallbackAssociatorKeepsPrimaryWhenEmbeddingAlsoFallsBack(t *testing.T) {
	primary := &stubAssociator{selection: AnimalSelection{Species: "cow", Strategy: strategyRandom, FallbackReason: "no_concept"}}
	embedding := &stubAssociator{selection: AnimalSelection{Species: "dog", Strategy: strategyRandom, FallbackReason: "no_available_embedding_candidate"}}
	chain := &embeddingFallbackAssociator{primary: primary, embedding: embedding}

	selection, err := chain.Select(context.Background(), "謎の入力", embeddingTestAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "cow" {
		t.Fatalf("selection = %+v, want primary fallback kept", selection)
	}
}

func TestFallbackAssociatorPropagatesPrimaryError(t *testing.T) {
	primary := &stubAssociator{err: errors.New("index unavailable")}
	embedding := &stubAssociator{selection: AnimalSelection{Species: "cat", Strategy: strategyEmbedding}}
	chain := &embeddingFallbackAssociator{primary: primary, embedding: embedding}

	if _, err := chain.Select(context.Background(), "x", embeddingTestAnimals(), rand.New(rand.NewSource(1))); err == nil {
		t.Fatal("want primary error propagated")
	}
	if embedding.calls != 0 {
		t.Fatalf("embedding calls = %d, want 0", embedding.calls)
	}
}

func TestEmbeddingAssociatorFromEnvUnsetReturnsNil(t *testing.T) {
	for _, name := range embeddingEnvNames {
		t.Setenv(name, "")
	}
	associator, err := embeddingAssociatorFromEnv(&stubRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if associator != nil {
		t.Fatalf("associator = %+v, want nil when env is unset", associator)
	}
}

func TestEmbeddingAssociatorFromEnvPartialConfigurationFails(t *testing.T) {
	for _, name := range embeddingEnvNames {
		t.Setenv(name, "")
	}
	t.Setenv("ZOOVOICE_EMBEDDING_PYTHON", "/usr/bin/python3")

	if _, err := embeddingAssociatorFromEnv(&stubRunner{}); err == nil {
		t.Fatal("want error for partial embedding configuration")
	}
}

func TestEmbeddingAssociatorFromEnvFullConfiguration(t *testing.T) {
	t.Setenv("ZOOVOICE_EMBEDDING_PYTHON", "/usr/bin/python3")
	t.Setenv("ZOOVOICE_EMBEDDING_RUNNER", "/app/runner.py")
	t.Setenv("ZOOVOICE_EMBEDDING_MODEL_DIR", "/app/model")
	t.Setenv("ZOOVOICE_EMBEDDING_ARTIFACTS_DIR", "/app/artifacts")

	associator, err := embeddingAssociatorFromEnv(&stubRunner{})
	if err != nil {
		t.Fatal(err)
	}
	if associator == nil {
		t.Fatal("want configured embedding associator")
	}
}
