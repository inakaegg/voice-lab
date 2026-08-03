package main

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
	"github.com/inakaegg/voice-lab/services/zoovoice/internal/animaldefs"
	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

const conceptNetSourceSHA256 = "accd65fe94038584295574ddc26e1500c1919c8c4532bf771811cafd0948af7e"

type SelectionStrategy string

const (
	strategyDirect     SelectionStrategy = "direct"
	strategyConceptNet SelectionStrategy = "conceptnet"
	strategyRandom     SelectionStrategy = "random_fallback"
	fallbackNoMatch                      = "no_direct_or_conceptnet_match"
)

type AnimalSelection struct {
	Species        string
	LabelJA        string
	EvidenceTerm   string
	Strategy       SelectionStrategy
	FallbackReason string
}

type animalAssociator interface {
	Select(context.Context, string, []availableAnimal, *rand.Rand) (AnimalSelection, error)
}

type conceptCandidateStore interface {
	Candidates(context.Context, []string) ([]conceptindex.Edge, error)
}

type associationEngine struct {
	aliases                     animaldefs.Catalog
	store                       conceptCandidateStore
	tokenizer                   *tokenizer.Tokenizer
	onomatopoeiaRequiresContext map[string]bool
}

type associationTerm struct {
	Text     string
	Position int
}

type transcriptTokenSpan struct {
	start      int
	end        int
	surface    string
	primaryPOS string
}

var relationMultipliers = map[string]float64{
	"RelatedTo":   1.0,
	"AtLocation":  1.0,
	"CapableOf":   0.9,
	"Desires":     0.8,
	"HasProperty": 0.6,
	"IsA":         0.5,
}

var soundContextTerms = map[string]struct{}{
	"鳴く": {}, "鳴る": {}, "鳴らす": {}, "吠える": {}, "叫ぶ": {},
	"聞こえる": {}, "響く": {}, "声": {}, "音": {}, "鳴き声": {}, "遠吠え": {},
}

var contextDependentPartsOfSpeech = map[string]struct{}{
	"助詞": {}, "助動詞": {}, "副詞": {}, "フィラー": {}, "接続詞": {}, "接頭詞": {}, "その他": {},
}

func newAssociationEngine(aliasesPath string, store conceptCandidateStore) (*associationEngine, error) {
	aliases, err := animaldefs.Load(aliasesPath)
	if err != nil {
		return nil, err
	}
	if store == nil {
		return nil, fmt.Errorf("ConceptNet candidate store is required")
	}
	jaTokenizer, err := tokenizer.New(ipa.Dict())
	if err != nil {
		return nil, fmt.Errorf("initialize Japanese tokenizer: %w", err)
	}
	requiresContext := make(map[string]bool)
	for _, definitions := range aliases {
		for _, alias := range definitions.Onomatopoeia {
			requiresContext[alias] = isContextDependentOnomatopoeia(jaTokenizer, alias)
		}
	}
	return &associationEngine{
		aliases: aliases, store: store, tokenizer: jaTokenizer, onomatopoeiaRequiresContext: requiresContext,
	}, nil
}

func (engine *associationEngine) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
	rng *rand.Rand,
) (AnimalSelection, error) {
	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return AnimalSelection{}, &APIError{
			Status:  422,
			Code:    "asr_empty",
			Message: "音声から発話を認識できませんでした。",
		}
	}
	if len(animals) == 0 {
		return AnimalSelection{}, &APIError{
			Status:  500,
			Code:    "association_failed",
			Message: "動物を選べませんでした。",
		}
	}
	available := make(map[string]availableAnimal, len(animals))
	for _, animal := range animals {
		available[animal.ID] = animal
	}
	terms := tokenizeAssociationTermsWith(engine.tokenizer, transcript)
	if direct, ok := engine.selectDirect(transcript, terms, available); ok {
		return direct, nil
	}

	queryTerms := make([]string, 0, len(terms))
	positions := make(map[string]int, len(terms))
	for _, term := range terms {
		queryTerms = append(queryTerms, term.Text)
		positions[term.Text] = term.Position
	}
	edges, err := engine.store.Candidates(ctx, queryTerms)
	if err != nil {
		return AnimalSelection{}, &APIError{
			Status:  500,
			Code:    "association_failed",
			Message: "動物を選べませんでした。",
			Err:     err,
		}
	}
	if concept, ok := selectConceptCandidate(edges, positions, available); ok {
		return concept, nil
	}

	choice := animals[rng.Intn(len(animals))]
	return AnimalSelection{
		Species:        choice.ID,
		LabelJA:        choice.LabelJA,
		Strategy:       strategyRandom,
		FallbackReason: fallbackNoMatch,
	}, nil
}

func (engine *associationEngine) selectDirect(
	transcript string,
	terms []associationTerm,
	available map[string]availableAnimal,
) (AnimalSelection, bool) {
	type directMatch struct {
		position int
		alias    string
		animal   availableAnimal
	}
	matches := make([]directMatch, 0)
	tokenSpans := transcriptTokenSpansFor(engine.tokenizer, transcript)
	tokenBoundaries := tokenBoundaryPositions(tokenSpans, len(transcript))
	hasSoundContext := containsSoundContext(terms)
	for animalID, aliases := range engine.aliases {
		animal, ok := available[animalID]
		if !ok {
			continue
		}
		for _, alias := range aliases.Terms {
			if position, exists := wholeAnimalTermAliasPosition(
				transcript,
				alias,
				tokenBoundaries,
				tokenSpans,
			); exists {
				matches = append(matches, directMatch{position: position, alias: alias, animal: animal})
			}
		}
		for _, alias := range aliases.Onomatopoeia {
			position, exists := wholeTokenAliasPosition(transcript, alias, tokenBoundaries)
			if !exists {
				continue
			}
			if engine.onomatopoeiaRequiresContext[alias] &&
				!hasSoundContext && !isStandaloneOnomatopoeia(transcript, alias) {
				continue
			}
			matches = append(matches, directMatch{position: position, alias: alias, animal: animal})
		}
	}
	if len(matches) == 0 {
		return AnimalSelection{}, false
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].position != matches[j].position {
			return matches[i].position < matches[j].position
		}
		if len(matches[i].alias) != len(matches[j].alias) {
			return len(matches[i].alias) > len(matches[j].alias)
		}
		return matches[i].animal.ID < matches[j].animal.ID
	})
	match := matches[0]
	return AnimalSelection{
		Species:      match.animal.ID,
		LabelJA:      match.animal.LabelJA,
		EvidenceTerm: match.alias,
		Strategy:     strategyDirect,
	}, true
}

func transcriptTokenSpansFor(
	jaTokenizer *tokenizer.Tokenizer,
	transcript string,
) []transcriptTokenSpan {
	spans := make([]transcriptTokenSpan, 0)
	for _, token := range jaTokenizer.Tokenize(transcript) {
		if token.Class == tokenizer.DUMMY || token.Surface == "" {
			continue
		}
		primaryPOS := ""
		if pos := token.POS(); len(pos) > 0 {
			primaryPOS = pos[0]
		}
		spans = append(spans, transcriptTokenSpan{
			start:      token.Position,
			end:        token.Position + len(token.Surface),
			surface:    token.Surface,
			primaryPOS: primaryPOS,
		})
	}
	return spans
}

func tokenBoundaryPositions(spans []transcriptTokenSpan, transcriptLength int) map[int]bool {
	boundaries := map[int]bool{0: true, transcriptLength: true}
	for _, span := range spans {
		boundaries[span.start] = true
		boundaries[span.end] = true
	}
	return boundaries
}

func wholeAnimalTermAliasPosition(
	transcript string,
	alias string,
	boundaries map[int]bool,
	spans []transcriptTokenSpan,
) (int, bool) {
	for offset := 0; offset <= len(transcript)-len(alias); {
		relative := strings.Index(transcript[offset:], alias)
		if relative < 0 {
			return 0, false
		}
		position := offset + relative
		end := position + len(alias)
		if boundaries[position] && boundaries[end] &&
			tokenRangeIsAnimalTerm(transcript, position, end, spans) {
			return position, true
		}
		_, size := utf8.DecodeRuneInString(transcript[position:])
		if size == 0 {
			return 0, false
		}
		offset = position + size
	}
	return 0, false
}

func tokenRangeIsAnimalTerm(
	transcript string,
	start int,
	end int,
	spans []transcriptTokenSpan,
) bool {
	cursor := start
	allNouns := true
	firstMatched := -1
	lastMatched := -1
	for index, span := range spans {
		if span.end <= start || span.start >= end {
			continue
		}
		if span.start != cursor || span.end > end {
			return false
		}
		if firstMatched < 0 {
			firstMatched = index
		}
		lastMatched = index
		if span.primaryPOS != "名詞" {
			allNouns = false
		}
		cursor = span.end
	}
	if cursor != end || firstMatched < 0 {
		return false
	}

	term := transcript[start:end]
	hiraganaTerm := isHiraganaOnly(term)
	if firstMatched > 0 {
		previous := spans[firstMatched-1]
		if previous.end == start && previous.primaryPOS == "名詞" {
			return false
		}
	}
	if lastMatched+1 < len(spans) {
		next := spans[lastMatched+1]
		if next.start == end && next.primaryPOS == "名詞" {
			return false
		}
	}

	if allNouns {
		if hiraganaTerm && firstMatched > 0 {
			previous := spans[firstMatched-1]
			if previous.end == start && predicatePartsOfSpeech[previous.primaryPOS] {
				return false
			}
		}
		return true
	}

	// Kagome parses clause-initial hiragana animal names such as かえるが as
	// verbs. Permit only a narrow subject/object form; particles and general
	// in-sentence verbs must never become direct animal mentions.
	if !hiraganaTerm || firstMatched != lastMatched ||
		spans[firstMatched].primaryPOS != "動詞" || !isClauseStart(firstMatched, start, spans) {
		return false
	}
	if lastMatched+1 >= len(spans) {
		return false
	}
	markerIndex := lastMatched + 1
	marker := spans[markerIndex]
	if marker.start != end || !ambiguousVerbNounMarkers[marker.surface] ||
		markerIndex+1 >= len(spans) {
		return false
	}
	following := spans[markerIndex+1]
	return following.start == marker.end && following.primaryPOS != "記号"
}

var ambiguousVerbNounMarkers = map[string]bool{"が": true, "は": true, "を": true}

var predicatePartsOfSpeech = map[string]bool{
	"動詞": true, "形容詞": true, "助動詞": true,
}

func isClauseStart(firstMatched, start int, spans []transcriptTokenSpan) bool {
	if start == 0 {
		return true
	}
	if firstMatched == 0 {
		return false
	}
	previous := spans[firstMatched-1]
	return previous.end == start && previous.primaryPOS == "記号"
}

func isHiraganaOnly(text string) bool {
	if text == "" {
		return false
	}
	for _, character := range text {
		if !unicode.In(character, unicode.Hiragana) {
			return false
		}
	}
	return true
}

func wholeTokenAliasPosition(transcript, alias string, boundaries map[int]bool) (int, bool) {
	for offset := 0; offset <= len(transcript)-len(alias); {
		relative := strings.Index(transcript[offset:], alias)
		if relative < 0 {
			return 0, false
		}
		position := offset + relative
		if boundaries[position] && boundaries[position+len(alias)] {
			return position, true
		}
		_, size := utf8.DecodeRuneInString(transcript[position:])
		if size == 0 {
			return 0, false
		}
		offset = position + size
	}
	return 0, false
}

func isContextDependentOnomatopoeia(jaTokenizer *tokenizer.Tokenizer, alias string) bool {
	for _, token := range jaTokenizer.Tokenize(alias) {
		if token.Class == tokenizer.DUMMY {
			continue
		}
		pos := token.POS()
		if len(pos) == 0 {
			return true
		}
		if _, dependent := contextDependentPartsOfSpeech[pos[0]]; dependent {
			return true
		}
	}
	return false
}

func containsSoundContext(terms []associationTerm) bool {
	for _, term := range terms {
		if _, exists := soundContextTerms[term.Text]; exists {
			return true
		}
	}
	return false
}

func isStandaloneOnomatopoeia(transcript, alias string) bool {
	trimmed := strings.TrimFunc(transcript, func(character rune) bool {
		return unicode.IsSpace(character) || unicode.IsPunct(character) || unicode.IsSymbol(character)
	})
	return trimmed == alias
}

func tokenizeAssociationTerms(transcript string) []associationTerm {
	jaTokenizer, err := tokenizer.New(ipa.Dict())
	if err != nil {
		return nil
	}
	return tokenizeAssociationTermsWith(jaTokenizer, transcript)
}

func tokenizeAssociationTermsWith(jaTokenizer *tokenizer.Tokenizer, transcript string) []associationTerm {
	tokens := jaTokenizer.Tokenize(transcript)
	type contentToken struct {
		position int
		forms    []string
	}
	content := make([]contentToken, 0, len(tokens))
	for _, token := range tokens {
		if token.Class == tokenizer.DUMMY || token.Surface == "" || excludedPartOfSpeech(token.POS()) {
			continue
		}
		forms := []string{token.Surface}
		if base, ok := token.BaseForm(); ok && base != "" && base != "*" {
			forms = append(forms, base)
		}
		if reading, ok := token.Reading(); ok && reading != "" && reading != "*" {
			forms = append(forms, reading)
		}
		content = append(content, contentToken{position: token.Position, forms: uniqueStrings(forms)})
	}

	terms := make([]associationTerm, 0, len(content)*6)
	seen := make(map[string]bool)
	add := func(text string, position int) {
		text = strings.TrimSpace(text)
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		terms = append(terms, associationTerm{Text: text, Position: position})
	}
	for index, token := range content {
		for _, form := range token.forms {
			add(form, token.position)
		}
		for length := 2; length <= 3 && index+length <= len(content); length++ {
			var compound strings.Builder
			for offset := 0; offset < length; offset++ {
				compound.WriteString(content[index+offset].forms[0])
			}
			add(compound.String(), token.position)
		}
	}
	return terms
}

func excludedPartOfSpeech(pos []string) bool {
	if len(pos) == 0 {
		return true
	}
	switch pos[0] {
	case "助詞", "助動詞", "記号", "フィラー", "その他":
		return true
	default:
		return false
	}
}

func uniqueStrings(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			result = append(result, value)
		}
	}
	return result
}

func selectConceptCandidate(
	edges []conceptindex.Edge,
	positions map[string]int,
	available map[string]availableAnimal,
) (AnimalSelection, bool) {
	type animalScore struct {
		score            float64
		evidence         string
		evidencePosition int
	}
	scores := make(map[string]animalScore)
	for _, edge := range edges {
		animal, availableHere := available[edge.AnimalID]
		position, queried := positions[edge.Concept]
		multiplier, supported := relationMultipliers[edge.Relation]
		if !availableHere || !queried || !supported {
			continue
		}
		score := scores[animal.ID]
		score.score += edge.Weight * multiplier
		if score.evidence == "" || position < score.evidencePosition ||
			(position == score.evidencePosition && edge.Concept < score.evidence) {
			score.evidence = edge.Concept
			score.evidencePosition = position
		}
		scores[animal.ID] = score
	}
	if len(scores) == 0 {
		return AnimalSelection{}, false
	}
	ids := make([]string, 0, len(scores))
	for animalID := range scores {
		ids = append(ids, animalID)
	}
	sort.Slice(ids, func(i, j int) bool {
		left, right := scores[ids[i]], scores[ids[j]]
		if math.Abs(left.score-right.score) > 1e-9 {
			return left.score > right.score
		}
		if left.evidencePosition != right.evidencePosition {
			return left.evidencePosition < right.evidencePosition
		}
		return ids[i] < ids[j]
	})
	winnerID := ids[0]
	winner := scores[winnerID]
	animal := available[winnerID]
	return AnimalSelection{
		Species:      winnerID,
		LabelJA:      animal.LabelJA,
		EvidenceTerm: winner.evidence,
		Strategy:     strategyConceptNet,
	}, true
}
