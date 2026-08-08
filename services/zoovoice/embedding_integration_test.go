package main

import (
	"context"
	"math/rand"
	"os"
	"testing"
	"time"
)

// 実際のrunnerプロセスとONNXモデルを使う通し確認。
// モデルはリポジトリ外にあるため、4つの環境変数がそろったときだけ実行する。
func TestEmbeddingAssociatorAgainstRealRunner(t *testing.T) {
	python := os.Getenv("ZOOVOICE_EMBEDDING_PYTHON")
	script := os.Getenv("ZOOVOICE_EMBEDDING_RUNNER")
	model := os.Getenv("ZOOVOICE_EMBEDDING_MODEL_DIR")
	artifacts := os.Getenv("ZOOVOICE_EMBEDDING_ARTIFACTS_DIR")
	if python == "" || script == "" || model == "" || artifacts == "" {
		t.Skip("set ZOOVOICE_EMBEDDING_{PYTHON,RUNNER,MODEL_DIR,ARTIFACTS_DIR} to run the real runner")
	}

	associator, err := newEmbeddingAssociator(execCommandRunner{}, python, script, model, artifacts, 2)
	if err != nil {
		t.Fatal(err)
	}
	animals := []availableAnimal{
		{ID: "cat", LabelJA: "猫"},
		{ID: "dog", LabelJA: "犬"},
		{ID: "cricket", LabelJA: "コオロギ"},
		{ID: "owl", LabelJA: "フクロウ"},
		{ID: "whale", LabelJA: "クジラ"},
		{ID: "cow", LabelJA: "牛"},
	}
	cases := []struct {
		transcript string
		want       string
	}{
		{"今日もうちのペットはにゃーにゃー鳴いてる", "cat"},
		{"犬の散歩に行ってきた", "dog"},
		{"夜中に虫の音がうるさかった", "cricket"},
	}

	rng := rand.New(rand.NewSource(7))
	for _, testCase := range cases {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		started := time.Now()
		selection, err := associator.Select(ctx, testCase.transcript, animals, rng)
		cancel()
		if err != nil {
			t.Fatalf("%s: %v", testCase.transcript, err)
		}
		t.Logf("%s -> %s (%s, %dms)",
			testCase.transcript, selection.LabelJA, selection.Strategy, time.Since(started).Milliseconds())
		if selection.Strategy != strategyEmbedding {
			t.Errorf("%s: strategy = %q, want %q", testCase.transcript, selection.Strategy, strategyEmbedding)
		}
		if selection.Species != testCase.want {
			t.Errorf("%s: species = %q, want %q", testCase.transcript, selection.Species, testCase.want)
		}
	}
}
