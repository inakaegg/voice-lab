package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

func TestServerPortUsesCloudRunPort(t *testing.T) {
	t.Setenv("ZOOVOICE_PORT", "")
	t.Setenv("PORT", "8080")

	if got := serverPort(); got != 8080 {
		t.Fatalf("serverPort() = %d, want 8080", got)
	}
}

func TestLoadRuntimeDependenciesRequiresASRAndConceptNetFiles(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	badIndex := filepath.Join(t.TempDir(), "index.sqlite")
	if err := os.WriteFile(badIndex, []byte("not sqlite"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		command string
		model   string
		index   string
	}{
		{name: "missing command", command: filepath.Join(t.TempDir(), "missing"), model: modelPath, index: badIndex},
		{name: "missing model", command: commandPath, model: filepath.Join(t.TempDir(), "missing"), index: badIndex},
		{name: "missing index", command: commandPath, model: modelPath, index: filepath.Join(t.TempDir(), "missing")},
		{name: "index metadata mismatch", command: commandPath, model: modelPath, index: badIndex},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("ZOOVOICE_WHISPER_COMMAND", test.command)
			t.Setenv("ZOOVOICE_ASR_MODEL_PATH", test.model)
			t.Setenv("ZOOVOICE_CONCEPTNET_INDEX_PATH", test.index)
			if _, err := loadRuntimeDependencies(execCommandRunner{}, "assets/animal-lexicon.json"); err == nil {
				t.Fatal("startup dependencies accepted invalid runtime files")
			}
		})
	}
}

func TestServerPortKeepsLocalOverride(t *testing.T) {
	t.Setenv("ZOOVOICE_PORT", "8091")
	t.Setenv("PORT", "8080")

	if got := serverPort(); got != 8091 {
		t.Fatalf("serverPort() = %d, want 8091", got)
	}
}

func TestDefaultComposeTimeoutLeavesHeadroomForNinetySecondGateway(t *testing.T) {
	if defaultComposeTimeout != 85*time.Second {
		t.Fatalf("defaultComposeTimeout = %s, want 85s", defaultComposeTimeout)
	}
}

func TestLoadRuntimeDependenciesRejectsLexiconIndexMismatch(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	root := t.TempDir()
	lexiconPath := filepath.Join(root, "animal-lexicon.json")
	lexicon, err := os.ReadFile(filepath.Join("assets", "animal-lexicon.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lexiconPath, lexicon, 0o600); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(root, "index.sqlite")
	if err := conceptindex.Build(context.Background(), conceptindex.BuildOptions{
		SourcePath: filepath.Join("testdata", "conceptnet-mini.tsv.gz"), OutputPath: indexPath,
		LexiconPath: lexiconPath, SourceVersion: "5.7.0-test",
		SourceURL:    "https://example.invalid/conceptnet-mini.tsv.gz",
		SourceSHA256: conceptNetSourceSHA256, CheckpointEvery: 100,
	}, nil); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(lexiconPath, append(lexicon, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZOOVOICE_WHISPER_COMMAND", commandPath)
	t.Setenv("ZOOVOICE_ASR_MODEL_PATH", modelPath)
	t.Setenv("ZOOVOICE_CONCEPTNET_INDEX_PATH", indexPath)
	if _, err := loadRuntimeDependencies(execCommandRunner{}, lexiconPath); err == nil {
		t.Fatal("startup accepted an index built from a different lexicon")
	}
}
