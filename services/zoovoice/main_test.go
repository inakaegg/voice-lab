package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestServerPortUsesCloudRunPort(t *testing.T) {
	t.Setenv("ZOOVOICE_PORT", "")
	t.Setenv("PORT", "8080")

	if got := serverPort(); got != 8080 {
		t.Fatalf("serverPort() = %d, want 8080", got)
	}
}

func TestLoadRuntimeDependenciesRequiresASRFilesAndAPIKey(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	tests := []struct {
		name    string
		command string
		model   string
		apiKey  string
	}{
		{name: "missing command", command: filepath.Join(t.TempDir(), "missing"), model: modelPath, apiKey: "test-key"},
		{name: "missing model", command: commandPath, model: filepath.Join(t.TempDir(), "missing"), apiKey: "test-key"},
		{name: "missing api key", command: commandPath, model: modelPath, apiKey: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("ZOOVOICE_WHISPER_COMMAND", test.command)
			t.Setenv("ZOOVOICE_ASR_MODEL_PATH", test.model)
			t.Setenv("OPENAI_API_KEY", test.apiKey)
			if _, err := loadRuntimeDependencies(execCommandRunner{}); err == nil {
				t.Fatal("startup dependencies accepted an incomplete runtime configuration")
			}
		})
	}
}

func TestLoadRuntimeDependenciesAcceptsCompleteConfiguration(t *testing.T) {
	commandPath, modelPath := createASRFiles(t)
	t.Setenv("ZOOVOICE_WHISPER_COMMAND", commandPath)
	t.Setenv("ZOOVOICE_ASR_MODEL_PATH", modelPath)
	t.Setenv("OPENAI_API_KEY", "test-key")
	if _, err := loadRuntimeDependencies(execCommandRunner{}); err != nil {
		t.Fatalf("loadRuntimeDependencies() failed: %v", err)
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
