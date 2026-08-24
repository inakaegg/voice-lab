package main

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"
)

type runtimeDependencies struct {
	transcriber transcriber
	segmenter   wordSegmenter
	associator  animalAssociator
}

func loadRuntimeDependencies(runner commandRunner) (*runtimeDependencies, error) {
	activeTranscriber, err := loadTranscriberFromEnv(runner)
	if err != nil {
		return nil, err
	}
	// 形態素辞書の読み込みは重いので、起動時に1つ作って使い回す。
	segmenter, err := newKagomeSegmenter()
	if err != nil {
		return nil, err
	}
	associator, err := loadAssociatorFromEnv()
	if err != nil {
		return nil, err
	}
	return &runtimeDependencies{
		transcriber: activeTranscriber,
		segmenter:   segmenter,
		associator:  associator,
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

// loadAssociatorFromEnv はLLM連想を組み立てる。APIキーが無ければ起動しない。
func loadAssociatorFromEnv() (animalAssociator, error) {
	timeoutSeconds, err := positiveIntegerEnv("ZOOVOICE_LLM_TIMEOUT_SECONDS", 20)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: time.Duration(timeoutSeconds) * time.Second}
	associator, err := newLLMAssociator(
		client,
		os.Getenv("ZOOVOICE_LLM_ENDPOINT"),
		os.Getenv("OPENAI_API_KEY"),
		os.Getenv("ZOOVOICE_LLM_MODEL"),
	)
	if err != nil {
		return nil, err
	}
	return associator, nil
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
