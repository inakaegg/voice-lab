package main

import "testing"

func TestServerPortUsesCloudRunPort(t *testing.T) {
	t.Setenv("ZOOVOICE_PORT", "")
	t.Setenv("PORT", "8080")

	if got := serverPort(); got != 8080 {
		t.Fatalf("serverPort() = %d, want 8080", got)
	}
}

func TestServerPortKeepsLocalOverride(t *testing.T) {
	t.Setenv("ZOOVOICE_PORT", "8091")
	t.Setenv("PORT", "8080")

	if got := serverPort(); got != 8091 {
		t.Fatalf("serverPort() = %d, want 8091", got)
	}
}
