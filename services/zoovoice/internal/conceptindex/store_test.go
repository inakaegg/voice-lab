package conceptindex

import (
	"context"
	"path/filepath"
	"testing"
)

func TestCandidatesEmptyInputDoesNotQuery(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "conceptnet.sqlite")
	buildMiniIndex(t, context.Background(), outputPath, 100, nil)
	store, err := Open(outputPath, testSourceSHA, testLexiconSHA(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	edges, err := store.Candidates(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(edges) != 0 {
		t.Fatalf("edges = %#v, want empty", edges)
	}
}
