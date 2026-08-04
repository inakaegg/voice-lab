package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

type associationFixture struct {
	ID                 string   `json:"id"`
	Role               string   `json:"role"`
	Kind               string   `json:"kind"`
	Input              string   `json:"input"`
	ExpectedStrategies []string `json:"expected_strategy"`
	AcceptableAnimals  []string `json:"acceptable_animals"`
	ExpectedEvidence   *string  `json:"expected_evidence,omitempty"`
}

func TestPortableAssociationEvaluation(t *testing.T) {
	store := buildPortableEvaluationIndex(t)
	defer store.Close()
	runAssociationEvaluation(t, store, true, map[string]int{
		"direct": 8, "concept_strategy": 8, "heldout_strategy": 4,
		"concept_top1": 8, "heldout_top1": 4, "unknown": 5, "homophone": 6,
		"compound": 2, "boundary": 3,
	})
}

func TestFullAssociationEvaluation(t *testing.T) {
	indexPath := os.Getenv("ZOOVOICE_CONCEPTNET_INDEX_PATH")
	if indexPath == "" {
		t.Skip("set ZOOVOICE_CONCEPTNET_INDEX_PATH to evaluate the immutable full index")
	}
	aliasSHA, err := conceptindex.FileSHA256(filepath.Join("assets", "association-aliases.json"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := conceptindex.Open(indexPath, conceptNetSourceSHA256, aliasSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	runAssociationEvaluation(t, store, false, map[string]int{
		"direct": 8, "concept_strategy": 6, "heldout_strategy": 3,
		"concept_top1": 5, "heldout_top1": 3, "unknown": 5, "homophone": 6,
		"compound": 2, "boundary": 3,
	})
}

func runAssociationEvaluation(t *testing.T, store *conceptindex.Store, strictConceptNet bool, minimums map[string]int) {
	t.Helper()
	engine, err := newAssociationEngine(filepath.Join("assets", "association-aliases.json"), store)
	if err != nil {
		t.Fatal(err)
	}
	fixtures := loadAssociationFixtures(t)
	animals := fullFixtureAnimals(t)

	counts := map[string]int{}
	for _, fixture := range fixtures {
		selection, selectionErr := engine.Select(context.Background(), fixture.Input, animals, rand.New(rand.NewSource(7)))
		contractOK := associationFixtureContractMatches(fixture, selection, selectionErr)
		if (strictConceptNet || fixture.Kind != "conceptnet") && !contractOK {
			t.Errorf(
				"%s: selection=%#v error=%v, want strategies=%v animals=%v evidence=%v",
				fixture.ID,
				selection,
				selectionErr,
				fixture.ExpectedStrategies,
				fixture.AcceptableAnimals,
				fixture.ExpectedEvidence,
			)
		}
		switch fixture.Kind {
		case "boundary":
			if fixture.ID == "B01" || fixture.ID == "B02" {
				if contractOK {
					counts["boundary"]++
				}
				continue
			}
		case "direct":
			if contractOK {
				counts["direct"]++
			}
		case "conceptnet":
			if selectionErr == nil && selection.Strategy == strategyConceptNet {
				counts["concept_strategy"]++
				if fixture.Role == "held-out" {
					counts["heldout_strategy"]++
				}
			}
			if selectionErr == nil && containsString(fixture.AcceptableAnimals, selection.Species) {
				counts["concept_top1"]++
				if fixture.Role == "held-out" {
					counts["heldout_top1"]++
				}
			}
		case "unknown":
			if contractOK {
				counts["unknown"]++
			}
		case "homophone":
			if contractOK {
				counts["homophone"]++
			}
		case "compound":
			if contractOK {
				counts["compound"]++
			}
		}
		if fixture.ID == "B03" && contractOK {
			counts["boundary"]++
		}
		if selectionErr != nil {
			t.Logf("%s: %v", fixture.ID, selectionErr)
		} else {
			t.Logf("%s: strategy=%s animal=%s evidence=%q", fixture.ID, selection.Strategy, selection.Species, selection.EvidenceTerm)
		}
	}

	for key, minimum := range minimums {
		if counts[key] < minimum {
			t.Errorf("%s = %d, want >= %d (all counts: %#v)", key, counts[key], minimum, counts)
		}
	}
}

func associationFixtureContractMatches(
	fixture associationFixture,
	selection AnimalSelection,
	selectionErr error,
) bool {
	if containsString(fixture.ExpectedStrategies, "error") {
		return selectionErr != nil
	}
	if selectionErr != nil || !containsString(fixture.ExpectedStrategies, string(selection.Strategy)) {
		return false
	}
	if len(fixture.AcceptableAnimals) > 0 && !containsString(fixture.AcceptableAnimals, selection.Species) {
		return false
	}
	if fixture.ExpectedEvidence != nil && selection.EvidenceTerm != *fixture.ExpectedEvidence {
		return false
	}
	if selection.Strategy == strategyRandom {
		return selection.EvidenceTerm == "" && selection.FallbackReason == fallbackNoMatch
	}
	return selection.EvidenceTerm != "" && selection.FallbackReason == ""
}

func buildPortableEvaluationIndex(t *testing.T) *conceptindex.Store {
	t.Helper()
	root := t.TempDir()
	sourcePath := filepath.Join(root, "portable-conceptnet.tsv.gz")
	source, err := os.Create(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	compressed := gzip.NewWriter(source)
	lines := []string{
		`/a/1\t/r/RelatedTo\t/c/ja/散歩/n\t/c/ja/犬/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/2\t/r/RelatedTo\t/c/ja/毛糸/n\t/c/ja/羊/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/3\t/r/AtLocation\t/c/ja/牧場/n\t/c/ja/牛/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/4\t/r/RelatedTo\t/c/ja/目覚まし/n\t/c/ja/鶏/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/5\t/r/AtLocation\t/c/ja/競馬場/n\t/c/ja/馬/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/6\t/r/AtLocation\t/c/ja/池/n\t/c/ja/家鴨/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/7\t/r/AtLocation\t/c/ja/田んぼ/n\t/c/ja/蛙/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
		`/a/8\t/r/RelatedTo\t/c/ja/虫/n\t/c/ja/蟋蟀/n\t{"license":"cc:by-sa/4.0","weight":3.0}`,
	}
	payload := strings.ReplaceAll(strings.Join(lines, "\n")+"\n", `\t`, "\t")
	if _, err := compressed.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	if err := source.Close(); err != nil {
		t.Fatal(err)
	}

	aliasPath := filepath.Join("assets", "association-aliases.json")
	outputPath := filepath.Join(root, "portable-conceptnet.sqlite")
	const portableSourceSHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := conceptindex.Build(context.Background(), conceptindex.BuildOptions{
		SourcePath: sourcePath, OutputPath: outputPath, AliasesPath: aliasPath,
		SourceVersion: "portable-test", SourceURL: "https://example.invalid/portable-conceptnet.tsv.gz",
		SourceSHA256: portableSourceSHA, CheckpointEvery: 100,
	}, nil); err != nil {
		t.Fatal(err)
	}
	aliasSHA, err := conceptindex.FileSHA256(aliasPath)
	if err != nil {
		t.Fatal(err)
	}
	store, err := conceptindex.Open(outputPath, portableSourceSHA, aliasSHA)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func loadAssociationFixtures(t *testing.T) []associationFixture {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("testdata", "association_fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []associationFixture
	if err := json.Unmarshal(payload, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}

func fullFixtureAnimals(t *testing.T) []availableAnimal {
	t.Helper()
	catalog, err := loadCatalog("assets/animals.json", "assets/cc0", "", log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	return catalog.Animals
}
