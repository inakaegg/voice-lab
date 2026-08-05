package main

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

func TestEvaluateAssociationFixturesCandidateBOnlyExpandsFallback(t *testing.T) {
	store := fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "牧場", AnimalID: "cow", Relation: "RelatedTo", Weight: 1},
		{Concept: "草原", AnimalID: "horse", Relation: "RelatedTo", Weight: 2},
		{Concept: "水鳥", AnimalID: "duck", Relation: "AtLocation", Weight: 1.5},
	}}
	engine := testAssociationEngine(t, store)
	fixtures := []associationFixture{
		{ID: "existing", Role: "regression", Input: "牧場へ行った"},
		{ID: "fallback", Role: "development", Input: "会議資料を確認した"},
	}
	expansions := map[string][]string{
		"existing": {"草原"},
		"fallback": {"水鳥"},
	}

	results, err := evaluateAssociationFixtures(
		context.Background(), engine, fixtures, testAnimals(), candidateB, expansions, 7,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := results[0].Selection; got == nil || got.Species != "cow" || got.EvidenceTerm != "牧場" {
		t.Fatalf("existing selection = %#v, want original cow concept", got)
	}
	if got := results[1].Selection; got == nil || got.Species != "duck" || got.EvidenceTerm != "水鳥" {
		t.Fatalf("fallback selection = %#v, want expanded duck concept", got)
	}
	if got := results[1].Selection.Score; got == nil || math.Abs(got.Total-1.5) > 1e-9 {
		t.Fatalf("score = %#v, want total 1.5", got)
	}
}

func TestEvaluateAssociationFixturesCandidateCCombinesExpansionBeforeConceptSelection(t *testing.T) {
	store := fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "牧場", AnimalID: "cow", Relation: "RelatedTo", Weight: 1},
		{Concept: "草原", AnimalID: "horse", Relation: "RelatedTo", Weight: 2},
	}}
	engine := testAssociationEngine(t, store)
	fixtures := []associationFixture{{ID: "case", Role: "development", Input: "牧場へ行った"}}

	results, err := evaluateAssociationFixtures(
		context.Background(), engine, fixtures, testAnimals(), candidateC,
		map[string][]string{"case": {"草原"}}, 7,
	)
	if err != nil {
		t.Fatal(err)
	}
	if got := results[0].Selection; got == nil || got.Species != "horse" || got.EvidenceTerm != "草原" {
		t.Fatalf("selection = %#v, want expanded horse concept", got)
	}
}

func TestAssociationSelectionScoreBreakdownIsDeterministic(t *testing.T) {
	store := fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "牧場", AnimalID: "cow", Relation: "RelatedTo", Weight: 1},
		{Concept: "ミルク", AnimalID: "cow", Relation: "HasProperty", Weight: 2},
	}}
	engine := testAssociationEngine(t, store)
	selection, err := engine.Select(
		context.Background(), "牧場でミルクをしぼった", testAnimals(), rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := &SelectionScore{
		Total: 2.2,
		Contributions: []ScoreContribution{
			{Concept: "ミルク", Relation: "HasProperty", Weight: 2, Multiplier: 0.6, Weighted: 1.2},
			{Concept: "牧場", Relation: "RelatedTo", Weight: 1, Multiplier: 1, Weighted: 1},
		},
	}
	if !reflect.DeepEqual(selection.Score, want) {
		t.Fatalf("score = %#v, want %#v", selection.Score, want)
	}
}

func TestAssociationEvalExtractCLIUsesProductionTerms(t *testing.T) {
	fixturesPath := filepath.Join(t.TempDir(), "fixtures.json")
	payload := []byte(`[{"id":"one","role":"development","kind":"conceptnet","input":"牧場でミルクをしぼった","expected_strategy":["conceptnet"],"acceptable_animals":["cow"]}]`)
	if err := os.WriteFile(fixturesPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := runAssociationEvalCLI(
		[]string{"extract", "--fixtures", fixturesPath, "--output", "-"},
		&stdout,
		&stderr,
	); exitCode != 0 {
		t.Fatalf("exit=%d stderr=%s", exitCode, stderr.String())
	}
	var result []associationExtractionResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result) != 1 || !containsString(result[0].Terms, "牧場") || !containsString(result[0].Terms, "ミルク") {
		t.Fatalf("result = %#v", result)
	}
}

func TestAssociationEvalExtractCLIExcludesReadingsFromEmbeddingTerms(t *testing.T) {
	fixturesPath := filepath.Join(t.TempDir(), "fixtures.json")
	payload := []byte(`[
		{"id":"return","role":"regression","kind":"unknown","input":"そろそろ帰る","expected_strategy":["random_fallback"],"acceptable_animals":[]},
		{"id":"change","role":"regression","kind":"unknown","input":"予定を変える","expected_strategy":["random_fallback"],"acceptable_animals":[]}
	]`)
	if err := os.WriteFile(fixturesPath, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if exitCode := runAssociationEvalCLI(
		[]string{"extract", "--fixtures", fixturesPath, "--output", "-"}, &stdout, &stderr,
	); exitCode != 0 {
		t.Fatalf("exit=%d stderr=%s", exitCode, stderr.String())
	}
	var result []associationExtractionResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	for _, item := range result {
		if !containsString(item.Terms, "カエル") {
			t.Fatalf("%s all terms = %v, want reading カエル", item.ID, item.Terms)
		}
		if containsString(item.EmbeddingTerms, "カエル") {
			t.Fatalf("%s embedding terms = %v, reading must be excluded", item.ID, item.EmbeddingTerms)
		}
	}
}

func TestEvaluateAssociationFixturesRejectsUnknownExpansionID(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	_, err := evaluateAssociationFixtures(
		context.Background(),
		engine,
		[]associationFixture{{ID: "known", Input: "会議"}},
		testAnimals(),
		candidateB,
		map[string][]string{"unknown": {"水鳥"}},
		7,
	)
	if err == nil {
		t.Fatal("expected unknown expansion ID error")
	}
}
