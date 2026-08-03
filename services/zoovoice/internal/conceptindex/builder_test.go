package conceptindex

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testSourceSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestBuildFiltersAndCanonicalizesJapaneseAnimalEdges(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "conceptnet.sqlite")
	buildMiniIndex(t, context.Background(), outputPath, 100, nil)

	store, err := Open(outputPath, testSourceSHA, testAliasSHA(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	edges, err := store.Candidates(context.Background(), []string{"散歩", "牧場", "レース", "会議", "walk"})
	if err != nil {
		t.Fatal(err)
	}
	if len(edges) != 3 {
		t.Fatalf("edges = %#v, want 3 Japanese animal edges", edges)
	}
	want := []Edge{
		{Concept: "レース", AnimalID: "horse", Relation: "CapableOf", Weight: 1.2},
		{Concept: "散歩", AnimalID: "dog", Relation: "RelatedTo", Weight: 3.0},
		{Concept: "牧場", AnimalID: "cow", Relation: "AtLocation", Weight: 1.5},
	}
	for index := range want {
		if edges[index] != want[index] {
			t.Fatalf("edge[%d] = %#v, want %#v", index, edges[index], want[index])
		}
	}
}

func TestBuildStoresRequiredMetadata(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "conceptnet.sqlite")
	buildMiniIndex(t, context.Background(), outputPath, 100, nil)

	metadata, err := ReadMetadata(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"schema_version", "source_version", "source_url", "source_sha256",
		"alias_sha256", "license", "transformation", "generated_at",
	} {
		if strings.TrimSpace(metadata[key]) == "" {
			t.Errorf("metadata[%q] is empty", key)
		}
	}
	if metadata["schema_version"] != SchemaVersion {
		t.Fatalf("schema_version = %q, want %q", metadata["schema_version"], SchemaVersion)
	}
	if metadata["license"] != "CC BY-SA 4.0" {
		t.Fatalf("license = %q", metadata["license"])
	}
}

func TestBuildResumesPartialDatabaseWithoutDuplicates(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "conceptnet.sqlite")
	ctx, cancel := context.WithCancel(context.Background())
	progress := cancelWriter{cancel: cancel}
	if err := buildMiniIndexError(ctx, outputPath, 2, progress); err == nil {
		t.Fatal("Build completed despite cancellation")
	}
	if _, err := os.Stat(outputPath + ".partial"); err != nil {
		t.Fatalf("partial database: %v", err)
	}

	buildMiniIndex(t, context.Background(), outputPath, 2, nil)
	store, err := Open(outputPath, testSourceSHA, testAliasSHA(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	edges, err := store.Candidates(context.Background(), []string{"散歩", "牧場", "レース"})
	if err != nil {
		t.Fatal(err)
	}
	if len(edges) != 3 {
		t.Fatalf("resumed edges = %#v, want no duplicates", edges)
	}
}

func TestOpenRejectsMetadataMismatch(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "conceptnet.sqlite")
	buildMiniIndex(t, context.Background(), outputPath, 100, nil)
	if _, err := Open(outputPath, strings.Repeat("f", 64), testAliasSHA(t)); err == nil {
		t.Fatal("Open accepted an unexpected source SHA")
	}
	if _, err := Open(outputPath, testSourceSHA, strings.Repeat("f", 64)); err == nil {
		t.Fatal("Open accepted an unexpected alias SHA")
	}
}

func testAliasSHA(t *testing.T) string {
	t.Helper()
	hash, err := FileSHA256(filepath.Join("..", "..", "assets", "association-aliases.json"))
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

type cancelWriter struct {
	cancel context.CancelFunc
}

func (writer cancelWriter) Write(payload []byte) (int, error) {
	writer.cancel()
	return len(payload), nil
}

func buildMiniIndex(t *testing.T, ctx context.Context, outputPath string, checkpoint int64, progress io.Writer) {
	t.Helper()
	if err := buildMiniIndexError(ctx, outputPath, checkpoint, progress); err != nil {
		t.Fatal(err)
	}
}

func buildMiniIndexError(ctx context.Context, outputPath string, checkpoint int64, progress io.Writer) error {
	root := filepath.Join("..", "..")
	aliasPath := filepath.Join(root, "assets", "association-aliases.json")
	return Build(ctx, BuildOptions{
		SourcePath:      filepath.Join(root, "testdata", "conceptnet-mini.tsv.gz"),
		OutputPath:      outputPath,
		AliasesPath:     aliasPath,
		SourceVersion:   "5.7.0-test",
		SourceURL:       "https://example.invalid/conceptnet-mini.tsv.gz",
		SourceSHA256:    testSourceSHA,
		CheckpointEvery: checkpoint,
	}, progress)
}
