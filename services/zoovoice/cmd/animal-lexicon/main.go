package main

import (
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var animalRootConcepts = []string{
	"動物", "哺乳類", "鳥", "鳥類", "魚", "魚類", "昆虫", "爬虫類", "両生類", "甲殻類", "軟体動物",
}

type options struct {
	sourcePath       string
	sourceSHA256     string
	judgmentsPath    string
	audioManifest    string
	candidatesOutput string
	outputPath       string
}

type judgmentFile struct {
	SchemaVersion int        `json:"schema_version"`
	Criteria      string     `json:"criteria"`
	Judgments     []judgment `json:"judgments"`
}

type judgment struct {
	ID           string   `json:"id"`
	Concept      string   `json:"concept"`
	LabelJA      string   `json:"label_ja"`
	Accepted     bool     `json:"accepted"`
	Reason       string   `json:"reason"`
	Onomatopoeia []string `json:"onomatopoeia"`
}

type audioManifestFile struct {
	SchemaVersion   int                   `json:"schema_version"`
	GeneratedFrom   string                `json:"generated_from"`
	SelectionPolicy string                `json:"selection_policy"`
	Model           string                `json:"model"`
	ModelRevision   string                `json:"model_revision"`
	License         string                `json:"license"`
	LicenseURL      string                `json:"license_url"`
	Notice          string                `json:"notice"`
	Animals         []audioManifestAnimal `json:"animals"`
}

type audioManifestAnimal struct {
	ID               string                   `json:"id"`
	LabelJA          string                   `json:"label_ja"`
	File             string                   `json:"file"`
	NormalizedSHA256 string                   `json:"normalized_sha256"`
	DurationSeconds  float64                  `json:"duration_seconds"`
	SampleRate       int                      `json:"sample_rate"`
	Channels         int                      `json:"channels"`
	BitsPerSample    int                      `json:"bits_per_sample"`
	MeanDBFS         float64                  `json:"mean_dbfs"`
	PeakDBFS         float64                  `json:"peak_dbfs"`
	SourceKind       string                   `json:"source_kind"`
	License          string                   `json:"license"`
	Creator          string                   `json:"creator"`
	LandingURL       string                   `json:"landing_url"`
	ProvenanceSHA256 string                   `json:"provenance_sha256,omitempty"`
	AdoptedCandidate audioManifestCandidate   `json:"adopted_candidate"`
	Candidates       []audioManifestCandidate `json:"candidates"`
}

type audioManifestCandidate struct {
	Variant      int    `json:"variant"`
	Seed         int    `json:"seed"`
	Prompt       string `json:"prompt"`
	SourceFile   string `json:"source_file"`
	SourceSHA256 string `json:"source_sha256"`
	ReceiptFile  string `json:"receipt_file"`
}

type lexiconFile struct {
	SchemaVersion int             `json:"schema_version"`
	Generated     bool            `json:"generated"`
	DoNotEdit     string          `json:"do_not_edit"`
	Metadata      lexiconMetadata `json:"metadata"`
	Animals       []lexiconAnimal `json:"animals"`
}

type lexiconMetadata struct {
	GeneratedBy         string   `json:"generated_by"`
	ConceptNetVersion   string   `json:"conceptnet_version"`
	ConceptNetSHA256    string   `json:"conceptnet_sha256"`
	JudgmentsSHA256     string   `json:"judgments_sha256"`
	AudioManifestSHA256 string   `json:"audio_manifest_sha256"`
	AnimalRootConcepts  []string `json:"animal_root_concepts"`
}

type lexiconAnimal struct {
	ID           string   `json:"id"`
	LabelJA      string   `json:"label_ja"`
	Terms        []string `json:"terms"`
	Onomatopoeia []string `json:"onomatopoeia"`
	AudioFile    string   `json:"audio_file"`
	AudioSHA256  string   `json:"audio_sha256"`
}

type conceptGraph struct {
	children          map[string]map[string]struct{}
	synonyms          map[string]map[string]struct{}
	machineAnimalSeed map[string]struct{}
}

func main() {
	var opts options
	flag.StringVar(&opts.sourcePath, "source", "", "ConceptNet assertions CSV gzip path")
	flag.StringVar(&opts.sourceSHA256, "source-sha256", "", "ConceptNet source SHA-256")
	flag.StringVar(&opts.judgmentsPath, "judgments", "", "AI judgment JSON path")
	flag.StringVar(&opts.audioManifest, "audio-manifest", "", "normalized audio manifest JSON path")
	flag.StringVar(&opts.candidatesOutput, "candidates-output", "", "candidate inventory JSON output path")
	flag.StringVar(&opts.outputPath, "output", "", "generated animal lexicon JSON output path")
	flag.Parse()
	if err := run(opts); err != nil {
		fmt.Fprintf(os.Stderr, "animal lexicon generation failed: %v\n", err)
		os.Exit(1)
	}
}

func run(opts options) error {
	if opts.sourcePath == "" || opts.sourceSHA256 == "" {
		return errors.New("source and source-sha256 are required")
	}
	if err := validateSHA256(opts.sourceSHA256); err != nil {
		return fmt.Errorf("source-sha256: %w", err)
	}
	actualSourceSHA, err := fileSHA256(opts.sourcePath)
	if err != nil {
		return fmt.Errorf("hash ConceptNet source: %w", err)
	}
	if actualSourceSHA != strings.ToLower(opts.sourceSHA256) {
		return errors.New("ConceptNet source SHA-256 mismatch")
	}
	graph, err := scanConceptNet(opts.sourcePath)
	if err != nil {
		return err
	}
	candidates := graph.animalCandidates()
	if len(candidates) < 10 {
		return fmt.Errorf("animal candidate extraction produced only %d concepts", len(candidates))
	}
	if opts.candidatesOutput != "" {
		payload := struct {
			SchemaVersion int      `json:"schema_version"`
			SourceSHA256  string   `json:"source_sha256"`
			Roots         []string `json:"animal_root_concepts"`
			Candidates    []string `json:"candidates"`
		}{1, actualSourceSHA, animalRootConcepts, sortedSet(candidates)}
		if err := writeJSON(opts.candidatesOutput, payload); err != nil {
			return err
		}
	}
	if opts.outputPath == "" {
		return nil
	}
	if opts.judgmentsPath == "" || opts.audioManifest == "" {
		return errors.New("judgments and audio-manifest are required when output is set")
	}
	return generateLexicon(opts, graph, candidates, actualSourceSHA)
}

func scanConceptNet(path string) (*conceptGraph, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open ConceptNet source: %w", err)
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		return nil, fmt.Errorf("open ConceptNet gzip: %w", err)
	}
	defer reader.Close()
	graph := &conceptGraph{
		children: map[string]map[string]struct{}{}, synonyms: map[string]map[string]struct{}{},
		machineAnimalSeed: map[string]struct{}{},
	}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), "\t")
		if len(fields) != 5 {
			return nil, fmt.Errorf("invalid ConceptNet row with %d fields", len(fields))
		}
		relation := strings.TrimPrefix(fields[1], "/r/")
		for _, endpoint := range fields[2:4] {
			if strings.Contains(endpoint, "/n/wn/animal") {
				if concept, japanese := japaneseConcept(endpoint); japanese && concept != "" {
					graph.machineAnimalSeed[concept] = struct{}{}
				}
			}
		}
		if relation != "IsA" && relation != "Synonym" {
			continue
		}
		left, leftJA := japaneseConcept(fields[2])
		right, rightJA := japaneseConcept(fields[3])
		if !leftJA || !rightJA || left == "" || right == "" {
			continue
		}
		switch relation {
		case "IsA":
			addEdge(graph.children, right, left)
		case "Synonym":
			addEdge(graph.synonyms, left, right)
			addEdge(graph.synonyms, right, left)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan ConceptNet source: %w", err)
	}
	return graph, nil
}

func (graph *conceptGraph) animalCandidates() map[string]struct{} {
	animals := make(map[string]struct{})
	queue := append([]string{}, animalRootConcepts...)
	queue = append(queue, sortedSet(graph.machineAnimalSeed)...)
	for _, root := range queue {
		animals[root] = struct{}{}
	}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for child := range graph.children[current] {
			if _, seen := animals[child]; seen {
				continue
			}
			animals[child] = struct{}{}
			queue = append(queue, child)
		}
	}
	for _, root := range animalRootConcepts {
		delete(animals, root)
	}
	for _, current := range sortedSet(animals) {
		for synonym := range graph.synonyms[current] {
			animals[synonym] = struct{}{}
		}
	}
	return animals
}

func generateLexicon(opts options, graph *conceptGraph, candidates map[string]struct{}, sourceSHA string) error {
	var judgments judgmentFile
	if err := decodeJSON(opts.judgmentsPath, &judgments); err != nil {
		return err
	}
	if judgments.SchemaVersion != 1 || strings.TrimSpace(judgments.Criteria) == "" || len(judgments.Judgments) == 0 {
		return errors.New("invalid AI judgment file")
	}
	var manifest audioManifestFile
	if err := decodeJSON(opts.audioManifest, &manifest); err != nil {
		return err
	}
	if manifest.SchemaVersion != 1 || len(manifest.Animals) == 0 {
		return errors.New("invalid audio manifest")
	}
	audioByID := make(map[string]audioManifestAnimal, len(manifest.Animals))
	for _, audio := range manifest.Animals {
		if audio.ID == "" || audio.File == "" || validateSHA256(audio.NormalizedSHA256) != nil {
			return fmt.Errorf("invalid audio manifest entry %q", audio.ID)
		}
		if _, exists := audioByID[audio.ID]; exists {
			return fmt.Errorf("duplicate audio manifest id %q", audio.ID)
		}
		actual, err := fileSHA256(filepath.Join(filepath.Dir(opts.audioManifest), audio.File))
		if err != nil || actual != strings.ToLower(audio.NormalizedSHA256) {
			return fmt.Errorf("audio file mismatch for %q", audio.ID)
		}
		audioByID[audio.ID] = audio
	}
	seenJudgments := map[string]struct{}{}
	seenTerms := map[string]string{}
	animalBuilders := map[string]*lexiconAnimal{}
	for _, item := range judgments.Judgments {
		item.ID = strings.TrimSpace(item.ID)
		item.Concept = normalizeTerm(item.Concept)
		item.LabelJA = strings.TrimSpace(item.LabelJA)
		item.Reason = strings.TrimSpace(item.Reason)
		if item.ID == "" || item.Concept == "" || item.LabelJA == "" || item.Reason == "" {
			return fmt.Errorf("incomplete judgment for %q", item.ID)
		}
		judgmentKey := item.ID + "\x00" + item.Concept
		if _, exists := seenJudgments[judgmentKey]; exists {
			return fmt.Errorf("duplicate judgment for %q and %q", item.ID, item.Concept)
		}
		seenJudgments[judgmentKey] = struct{}{}
		if _, ok := candidates[item.Concept]; !ok {
			return fmt.Errorf("judgment concept %q is not an extracted animal candidate", item.Concept)
		}
		if !item.Accepted {
			continue
		}
		audio, ok := audioByID[item.ID]
		if !ok {
			return fmt.Errorf("accepted animal %q has no audio", item.ID)
		}
		if audio.LabelJA != item.LabelJA {
			return fmt.Errorf("label mismatch for %q", item.ID)
		}
		terms := graph.termsFor(item.Concept)
		if len(terms) == 0 {
			return fmt.Errorf("accepted animal %q has no terms", item.ID)
		}
		builder := animalBuilders[item.ID]
		if builder == nil {
			builder = &lexiconAnimal{
				ID: item.ID, LabelJA: item.LabelJA,
				AudioFile:   filepath.ToSlash(filepath.Join(filepath.Base(filepath.Dir(opts.audioManifest)), audio.File)),
				AudioSHA256: strings.ToLower(audio.NormalizedSHA256),
			}
			animalBuilders[item.ID] = builder
		} else if builder.LabelJA != item.LabelJA {
			return fmt.Errorf("inconsistent judgment labels for %q", item.ID)
		}
		builder.Terms = append(builder.Terms, terms...)
		builder.Onomatopoeia = append(builder.Onomatopoeia, item.Onomatopoeia...)
	}
	if len(animalBuilders) == 0 {
		return errors.New("AI judgment file accepted no animals")
	}
	animals := make([]lexiconAnimal, 0, len(animalBuilders))
	for _, animal := range animalBuilders {
		animal.Terms = uniqueNormalized(animal.Terms)
		animal.Onomatopoeia = uniqueNormalized(animal.Onomatopoeia)
		for _, term := range append(append([]string{}, animal.Terms...), animal.Onomatopoeia...) {
			if owner, exists := seenTerms[term]; exists && owner != animal.ID {
				return fmt.Errorf("term %q is duplicated by %q and %q", term, owner, animal.ID)
			}
			seenTerms[term] = animal.ID
		}
		animals = append(animals, *animal)
	}
	sort.Slice(animals, func(i, j int) bool { return animals[i].ID < animals[j].ID })
	judgmentSHA, _ := fileSHA256(opts.judgmentsPath)
	manifestSHA, _ := fileSHA256(opts.audioManifest)
	output := lexiconFile{
		SchemaVersion: 1,
		Generated:     true,
		DoNotEdit:     "Generated by cmd/animal-lexicon; edit the judgments or audio manifest and regenerate.",
		Metadata: lexiconMetadata{
			GeneratedBy: "services/zoovoice/cmd/animal-lexicon", ConceptNetVersion: "5.7.0",
			ConceptNetSHA256: sourceSHA, JudgmentsSHA256: judgmentSHA, AudioManifestSHA256: manifestSHA,
			AnimalRootConcepts: animalRootConcepts,
		},
		Animals: animals,
	}
	return writeJSON(opts.outputPath, output)
}

func (graph *conceptGraph) termsFor(concept string) []string {
	seen := map[string]struct{}{concept: {}}
	for synonym := range graph.synonyms[concept] {
		seen[synonym] = struct{}{}
	}
	for term := range seen {
		seen[hiraganaToKatakana(term)] = struct{}{}
		seen[katakanaToHiragana(term)] = struct{}{}
	}
	delete(seen, "")
	return sortedSet(seen)
}

func uniqueNormalized(values []string) []string {
	seen := map[string]struct{}{}
	for _, value := range values {
		value = normalizeTerm(value)
		if value != "" {
			seen[value] = struct{}{}
			seen[hiraganaToKatakana(value)] = struct{}{}
			seen[katakanaToHiragana(value)] = struct{}{}
		}
	}
	return sortedSet(seen)
}

func japaneseConcept(uri string) (string, bool) {
	if !strings.HasPrefix(uri, "/c/ja/") {
		return "", false
	}
	value := strings.SplitN(strings.TrimPrefix(uri, "/c/ja/"), "/", 2)[0]
	decoded, err := url.PathUnescape(value)
	if err != nil {
		return "", false
	}
	return normalizeTerm(decoded), true
}

func normalizeTerm(value string) string {
	return strings.TrimSpace(strings.ReplaceAll(value, "_", " "))
}

func hiraganaToKatakana(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0x3041 && r <= 0x3096 {
			return r + 0x60
		}
		return r
	}, value)
}

func katakanaToHiragana(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= 0x30A1 && r <= 0x30F6 {
			return r - 0x60
		}
		return r
	}, value)
}

func addEdge(graph map[string]map[string]struct{}, from, to string) {
	if graph[from] == nil {
		graph[from] = map[string]struct{}{}
	}
	graph[from][to] = struct{}{}
}

func sortedSet(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func validateSHA256(value string) error {
	if len(value) != sha256.Size*2 {
		return errors.New("must contain 64 hexadecimal characters")
	}
	_, err := hex.DecodeString(value)
	return err
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func decodeJSON(path string, destination any) error {
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode %s: %w", path, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("%s must contain one JSON value", path)
	}
	return nil
}

func writeJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	payload = append(payload, '\n')
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
