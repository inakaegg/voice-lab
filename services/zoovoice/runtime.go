package main

import (
	"fmt"
	"os"
	"strconv"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

type runtimeDependencies struct {
	transcriber transcriber
	associator  animalAssociator
	store       *conceptindex.Store
}

func loadRuntimeDependencies(
	runner commandRunner,
	lexiconPath string,
) (*runtimeDependencies, error) {
	activeTranscriber, err := loadTranscriberFromEnv(runner)
	if err != nil {
		return nil, err
	}
	associator, store, err := loadAssociatorFromEnv(runner, lexiconPath)
	if err != nil {
		return nil, err
	}
	return &runtimeDependencies{
		transcriber: activeTranscriber,
		associator:  associator,
		store:       store,
	}, nil
}

// loadTranscriberFromEnv はwhisperによるASRを組み立てる。音声入力にだけ要る。
func loadTranscriberFromEnv(runner commandRunner) (transcriber, error) {
	threads, err := positiveIntegerEnv("ZOOVOICE_ASR_THREADS", 2)
	if err != nil {
		return nil, err
	}
	return newWhisperTranscriber(
		runner,
		os.Getenv("ZOOVOICE_WHISPER_COMMAND"),
		os.Getenv("ZOOVOICE_ASR_MODEL_PATH"),
		threads,
	)
}

// loadAssociatorFromEnv は連想indexを開いて連想エンジンを組み立てる。
// 返したstoreは呼び出し側がCloseする。
func loadAssociatorFromEnv(
	runner commandRunner,
	lexiconPath string,
) (animalAssociator, *conceptindex.Store, error) {
	indexPath := os.Getenv("ZOOVOICE_CONCEPTNET_INDEX_PATH")
	if !regularFileExists(indexPath) {
		return nil, nil, fmt.Errorf("ZOOVOICE_CONCEPTNET_INDEX_PATH must be a regular file")
	}
	lexiconSHA, err := conceptindex.FileSHA256(lexiconPath)
	if err != nil {
		return nil, nil, fmt.Errorf("hash animal lexicon: %w", err)
	}
	store, err := conceptindex.Open(indexPath, conceptNetSourceSHA256, lexiconSHA)
	if err != nil {
		return nil, nil, err
	}
	engine, err := newAssociationEngine(lexiconPath, store)
	if err != nil {
		store.Close()
		return nil, nil, err
	}
	associator := animalAssociator(engine)
	embedding, err := embeddingAssociatorFromEnv(runner)
	if err != nil {
		store.Close()
		return nil, nil, err
	}
	if embedding != nil {
		associator = &embeddingFallbackAssociator{primary: engine, embedding: embedding}
	}
	return associator, store, nil
}

func (dependencies *runtimeDependencies) Close() error {
	return dependencies.store.Close()
}

func positiveIntegerEnv(name string, fallback int) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		return 0, fmt.Errorf("%s must be a positive integer", name)
	}
	return parsed, nil
}
