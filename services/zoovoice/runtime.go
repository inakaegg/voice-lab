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
	threads, err := positiveIntegerEnv("ZOOVOICE_ASR_THREADS", 2)
	if err != nil {
		return nil, err
	}
	activeTranscriber, err := newWhisperTranscriber(
		runner,
		os.Getenv("ZOOVOICE_WHISPER_COMMAND"),
		os.Getenv("ZOOVOICE_ASR_MODEL_PATH"),
		threads,
	)
	if err != nil {
		return nil, err
	}
	indexPath := os.Getenv("ZOOVOICE_CONCEPTNET_INDEX_PATH")
	if !regularFileExists(indexPath) {
		return nil, fmt.Errorf("ZOOVOICE_CONCEPTNET_INDEX_PATH must be a regular file")
	}
	lexiconSHA, err := conceptindex.FileSHA256(lexiconPath)
	if err != nil {
		return nil, fmt.Errorf("hash animal lexicon: %w", err)
	}
	store, err := conceptindex.Open(indexPath, conceptNetSourceSHA256, lexiconSHA)
	if err != nil {
		return nil, err
	}
	associator, err := newAssociationEngine(lexiconPath, store)
	if err != nil {
		store.Close()
		return nil, err
	}
	return &runtimeDependencies{
		transcriber: activeTranscriber,
		associator:  associator,
		store:       store,
	}, nil
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
