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
	strategyPun        SelectionStrategy = "pun"
	strategyConceptNet SelectionStrategy = "conceptnet"
	strategyRandom     SelectionStrategy = "random_fallback"
	fallbackNoMatch                      = "no_association_match"
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
	aliases   animaldefs.Catalog
	store     conceptCandidateStore
	tokenizer *tokenizer.Tokenizer
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
	return &associationEngine{aliases: aliases, store: store, tokenizer: jaTokenizer}, nil
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
	if literal, ok := engine.selectLiteral(transcript, available); ok {
		return literal, nil
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

func (engine *associationEngine) selectLiteral(
	transcript string,
	available map[string]availableAnimal,
) (AnimalSelection, bool) {
	type literalMatch struct {
		position int
		alias    string
		animal   availableAnimal
		strategy SelectionStrategy
	}
	matches := make([]literalMatch, 0)
	tokenSpans := transcriptTokenSpansFor(engine.tokenizer, transcript)
	tokenBoundaries := tokenBoundaryPositions(tokenSpans, len(transcript))
	for animalID, aliases := range engine.aliases {
		animal, ok := available[animalID]
		if !ok {
			continue
		}
		for _, alias := range aliases.Terms {
			for _, position := range wholeTokenAliasPositions(transcript, alias, tokenBoundaries) {
				end := position + len(alias)
				firstMatched, lastMatched, exists := matchingTokenRange(position, end, tokenSpans)
				if !exists || tokenRangeContainsParticle(firstMatched, lastMatched, tokenSpans) {
					continue
				}
				matches = append(matches, literalMatch{
					position: position,
					alias:    alias,
					animal:   animal,
					strategy: classifyTermLiteral(alias, firstMatched, lastMatched, tokenSpans),
				})
			}
		}
		for _, alias := range aliases.Onomatopoeia {
			for _, position := range wholeTokenAliasPositions(transcript, alias, tokenBoundaries) {
				if _, _, exists := matchingTokenRange(position, position+len(alias), tokenSpans); !exists {
					continue
				}
				matches = append(matches, literalMatch{
					position: position,
					alias:    alias,
					animal:   animal,
					strategy: strategyDirect,
				})
			}
		}
	}
	if len(matches) == 0 {
		return AnimalSelection{}, false
	}
	sort.Slice(matches, func(i, j int) bool {
		if matches[i].strategy != matches[j].strategy {
			return matches[i].strategy == strategyDirect
		}
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
		Strategy:     match.strategy,
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

func wholeTokenAliasPositions(transcript, alias string, boundaries map[int]bool) []int {
	positions := make([]int, 0)
	for offset := 0; offset <= len(transcript)-len(alias); {
		relative := strings.Index(transcript[offset:], alias)
		if relative < 0 {
			break
		}
		position := offset + relative
		end := position + len(alias)
		if boundaries[position] && boundaries[end] {
			positions = append(positions, position)
		}
		_, size := utf8.DecodeRuneInString(transcript[position:])
		if size == 0 {
			break
		}
		offset = position + size
	}
	return positions
}

func matchingTokenRange(
	start int,
	end int,
	spans []transcriptTokenSpan,
) (int, int, bool) {
	cursor := start
	firstMatched := -1
	lastMatched := -1
	for index, span := range spans {
		if span.end <= start || span.start >= end {
			continue
		}
		if span.start != cursor || span.end > end {
			return 0, 0, false
		}
		if firstMatched < 0 {
			firstMatched = index
		}
		lastMatched = index
		cursor = span.end
	}
	if cursor != end || firstMatched < 0 {
		return 0, 0, false
	}
	return firstMatched, lastMatched, true
}

func tokenRangeContainsParticle(firstMatched, lastMatched int, spans []transcriptTokenSpan) bool {
	for index := firstMatched; index <= lastMatched; index++ {
		if spans[index].primaryPOS == "助詞" || spans[index].primaryPOS == "助動詞" {
			return true
		}
	}
	return false
}

func classifyTermLiteral(
	alias string,
	firstMatched int,
	lastMatched int,
	spans []transcriptTokenSpan,
) SelectionStrategy {
	allNouns := tokenRangeIsAllNouns(firstMatched, lastMatched, spans)
	if containsHanOrKatakana(alias) && allNouns {
		return strategyDirect
	}
	if isHiraganaOnly(alias) {
		if isClauseInitialHiraganaVerb(firstMatched, lastMatched, spans) {
			return strategyDirect
		}
		if hasAdjacentContentToken(firstMatched, lastMatched, spans) {
			return strategyPun
		}
		if allNouns {
			return strategyDirect
		}
	}
	return strategyPun
}

func isClauseInitialHiraganaVerb(firstMatched, lastMatched int, spans []transcriptTokenSpan) bool {
	if firstMatched != lastMatched ||
		spans[firstMatched].primaryPOS != "動詞" ||
		!isClauseStart(firstMatched, spans[firstMatched].start, spans) {
		return false
	}
	if lastMatched+1 >= len(spans) {
		return false
	}
	markerIndex := lastMatched + 1
	marker := spans[markerIndex]
	if marker.start != spans[lastMatched].end || !ambiguousVerbNounMarkers[marker.surface] ||
		markerIndex+1 >= len(spans) {
		return false
	}
	following := spans[markerIndex+1]
	return following.start == marker.end && following.primaryPOS != "記号"
}

var ambiguousVerbNounMarkers = map[string]bool{"が": true, "は": true, "を": true}

var contentPartsOfSpeech = map[string]bool{
	"名詞": true, "動詞": true, "形容詞": true,
}

func hasAdjacentContentToken(firstMatched, lastMatched int, spans []transcriptTokenSpan) bool {
	if firstMatched > 0 {
		previous := spans[firstMatched-1]
		if previous.end == spans[firstMatched].start && contentPartsOfSpeech[previous.primaryPOS] {
			return true
		}
	}
	if lastMatched+1 < len(spans) {
		next := spans[lastMatched+1]
		if next.start == spans[lastMatched].end && contentPartsOfSpeech[next.primaryPOS] {
			return true
		}
	}
	return false
}

func tokenRangeIsAllNouns(firstMatched, lastMatched int, spans []transcriptTokenSpan) bool {
	for index := firstMatched; index <= lastMatched; index++ {
		if spans[index].primaryPOS != "名詞" {
			return false
		}
	}
	return true
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

func containsHanOrKatakana(text string) bool {
	for _, character := range text {
		if unicode.In(character, unicode.Han, unicode.Katakana) {
			return true
		}
	}
	return false
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
		end      int
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
		content = append(content, contentToken{
			position: token.Position,
			end:      token.Position + len(token.Surface),
			forms:    uniqueStrings(forms),
		})
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
			contiguous := true
			for offset := 0; offset < length; offset++ {
				if offset > 0 && content[index+offset-1].end != content[index+offset].position {
					contiguous = false
					break
				}
				compound.WriteString(content[index+offset].forms[0])
			}
			if contiguous {
				add(compound.String(), token.position)
			}
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
