package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strings"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

type associationCandidate string

const (
	candidateA associationCandidate = "A"
	candidateB associationCandidate = "B"
	candidateC associationCandidate = "C"
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

type associationExtractionResult struct {
	ID             string   `json:"id"`
	Role           string   `json:"role"`
	Kind           string   `json:"kind"`
	Input          string   `json:"input"`
	Terms          []string `json:"terms"`
	EmbeddingTerms []string `json:"embedding_terms"`
}

type associationEvaluationError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type associationEvaluationResult struct {
	ID             string                      `json:"id"`
	Role           string                      `json:"role"`
	Kind           string                      `json:"kind"`
	Input          string                      `json:"input"`
	Candidate      associationCandidate        `json:"candidate"`
	ExtractedTerms []string                    `json:"extracted_terms"`
	ExpandedTerms  []string                    `json:"expanded_terms,omitempty"`
	Selection      *AnimalSelection            `json:"selection,omitempty"`
	Error          *associationEvaluationError `json:"error,omitempty"`
	ContractOK     bool                        `json:"contract_ok"`
	selectionErr   error
}

func (result associationEvaluationResult) selectionAndError() (AnimalSelection, error) {
	if result.Selection == nil {
		return AnimalSelection{}, result.selectionErr
	}
	return *result.Selection, result.selectionErr
}

func evaluateAssociationFixtures(
	ctx context.Context,
	engine *associationEngine,
	fixtures []associationFixture,
	animals []availableAnimal,
	candidate associationCandidate,
	expansions map[string][]string,
	seed int64,
) ([]associationEvaluationResult, error) {
	if candidate != candidateA && candidate != candidateB && candidate != candidateC {
		return nil, fmt.Errorf("candidate must be A, B, or C")
	}
	fixtureIDs := make(map[string]bool, len(fixtures))
	for _, fixture := range fixtures {
		if strings.TrimSpace(fixture.ID) == "" {
			return nil, fmt.Errorf("fixture ID is required")
		}
		if fixtureIDs[fixture.ID] {
			return nil, fmt.Errorf("duplicate fixture ID %q", fixture.ID)
		}
		fixtureIDs[fixture.ID] = true
	}
	for fixtureID := range expansions {
		if !fixtureIDs[fixtureID] {
			return nil, fmt.Errorf("expansion references unknown fixture ID %q", fixtureID)
		}
	}

	results := make([]associationEvaluationResult, 0, len(fixtures))
	for _, fixture := range fixtures {
		terms := tokenizeAssociationTermsWith(engine.tokenizer, fixture.Input)
		extracted := make([]string, 0, len(terms))
		for _, term := range terms {
			extracted = append(extracted, term.Text)
		}
		expanded := cleanedStrings(expansions[fixture.ID])
		fixtureRNG := rand.New(rand.NewSource(seed))
		var selection AnimalSelection
		var selectionErr error
		switch candidate {
		case candidateA:
			selection, selectionErr = engine.Select(ctx, fixture.Input, animals, fixtureRNG)
		case candidateB:
			selection, selectionErr = engine.selectWithExpansions(
				ctx, fixture.Input, animals, fixtureRNG, expanded, true,
			)
		case candidateC:
			selection, selectionErr = engine.selectWithExpansions(
				ctx, fixture.Input, animals, fixtureRNG, expanded, false,
			)
		}
		result := associationEvaluationResult{
			ID: fixture.ID, Role: fixture.Role, Kind: fixture.Kind, Input: fixture.Input,
			Candidate: candidate, ExtractedTerms: extracted, ExpandedTerms: expanded,
			selectionErr: selectionErr,
		}
		if selectionErr != nil {
			result.Error = evaluationErrorFrom(selectionErr)
		} else {
			selectionCopy := selection
			result.Selection = &selectionCopy
		}
		result.ContractOK = associationFixtureContractMatches(fixture, selection, selectionErr)
		results = append(results, result)
	}
	return results, nil
}

func cleanedStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func evaluationErrorFrom(err error) *associationEvaluationError {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return &associationEvaluationError{Code: apiError.Code, Message: apiError.Message}
	}
	return &associationEvaluationError{Code: "evaluation_failed", Message: err.Error()}
}

func associationFixtureContractMatches(
	fixture associationFixture,
	selection AnimalSelection,
	selectionErr error,
) bool {
	if stringSliceContains(fixture.ExpectedStrategies, "error") {
		return selectionErr != nil
	}
	if selectionErr != nil || !stringSliceContains(fixture.ExpectedStrategies, string(selection.Strategy)) {
		return false
	}
	if len(fixture.AcceptableAnimals) > 0 && !stringSliceContains(fixture.AcceptableAnimals, selection.Species) {
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

func stringSliceContains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func runAssociationEvalCLI(arguments []string, stdout, stderr io.Writer) int {
	if len(arguments) == 0 {
		fmt.Fprintln(stderr, "usage: association-eval <extract|evaluate> [options]")
		return 2
	}
	var err error
	switch arguments[0] {
	case "extract":
		err = runAssociationExtract(arguments[1:], stdout, stderr)
	case "evaluate":
		err = runAssociationEvaluate(arguments[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown association-eval command %q\n", arguments[0])
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "association-eval failed: %v\n", err)
		return 1
	}
	return 0
}

func runAssociationExtract(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("association-eval extract", flag.ContinueOnError)
	flags.SetOutput(stderr)
	fixturesPath := flags.String("fixtures", "", "association fixture JSON path")
	outputPath := flags.String("output", "-", "output JSON path or - for stdout")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	fixtures, err := readAssociationFixtures(*fixturesPath)
	if err != nil {
		return err
	}
	result := make([]associationExtractionResult, 0, len(fixtures))
	for _, fixture := range fixtures {
		terms := tokenizeAssociationTerms(fixture.Input)
		texts := make([]string, 0, len(terms))
		embeddingTerms := make([]string, 0, len(terms))
		for _, term := range terms {
			texts = append(texts, term.Text)
			if term.EmbeddingEligible {
				embeddingTerms = append(embeddingTerms, term.Text)
			}
		}
		result = append(result, associationExtractionResult{
			ID: fixture.ID, Role: fixture.Role, Kind: fixture.Kind, Input: fixture.Input,
			Terms: texts, EmbeddingTerms: embeddingTerms,
		})
	}
	return writeAssociationJSON(*outputPath, result, stdout)
}

func runAssociationEvaluate(arguments []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("association-eval evaluate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	fixturesPath := flags.String("fixtures", "", "association fixture JSON path")
	expansionsPath := flags.String("expansions", "", "fixture ID to expanded terms JSON path")
	lexiconPath := flags.String("lexicon", "", "animal lexicon JSON path")
	indexPath := flags.String("index", "", "ConceptNet SQLite index path")
	candidateName := flags.String("candidate", "A", "candidate A, B, or C")
	seed := flags.Int64("seed", 7, "deterministic fallback seed")
	outputPath := flags.String("output", "-", "output JSON path or - for stdout")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	for name, value := range map[string]string{
		"fixtures": *fixturesPath, "lexicon": *lexiconPath, "index": *indexPath,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("--%s is required", name)
		}
	}
	fixtures, err := readAssociationFixtures(*fixturesPath)
	if err != nil {
		return err
	}
	expansions := map[string][]string{}
	if *expansionsPath != "" {
		if err := readAssociationJSON(*expansionsPath, &expansions); err != nil {
			return err
		}
	}
	lexiconSHA, err := conceptindex.FileSHA256(*lexiconPath)
	if err != nil {
		return fmt.Errorf("hash animal lexicon: %w", err)
	}
	store, err := conceptindex.Open(*indexPath, conceptNetSourceSHA256, lexiconSHA)
	if err != nil {
		return err
	}
	defer store.Close()
	engine, err := newAssociationEngine(*lexiconPath, store)
	if err != nil {
		return err
	}
	catalog, err := loadCatalog(*lexiconPath, filepath.Dir(*lexiconPath))
	if err != nil {
		return err
	}
	results, err := evaluateAssociationFixtures(
		context.Background(), engine, fixtures, catalog.Animals,
		associationCandidate(strings.ToUpper(*candidateName)), expansions, *seed,
	)
	if err != nil {
		return err
	}
	return writeAssociationJSON(*outputPath, results, stdout)
}

func readAssociationFixtures(path string) ([]associationFixture, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("--fixtures is required")
	}
	var fixtures []associationFixture
	if err := readAssociationJSON(path, &fixtures); err != nil {
		return nil, err
	}
	return fixtures, nil
}

func readAssociationJSON(path string, destination any) error {
	payload, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(payload, destination); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	return nil
}

func writeAssociationJSON(path string, value any, stdout io.Writer) error {
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if path == "-" {
		_, err = stdout.Write(payload)
		return err
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
