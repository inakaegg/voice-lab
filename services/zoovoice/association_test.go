package main

import (
	"context"
	"errors"
	"math/rand"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/conceptindex"
)

func TestAssociationDirectMentions(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	tests := []struct {
		transcript string
		animalID   string
	}{
		{"犬が公園で元気に走っている", "dog"},
		{"猫が窓辺で眠っている", "cat"},
		{"牛が牧場で草を食べている", "cow"},
		{"コケコッコーで朝目覚めた", "rooster"},
		{"馬に乗って草原を進んだ", "horse"},
		{"ライオンの大きな声が聞こえた", "lion"},
		{"豚肉は美味しいです", "pig"},
		{"猫のあとに犬が来た", "cat"},
	}
	for _, test := range tests {
		t.Run(test.transcript, func(t *testing.T) {
			selection, err := engine.Select(context.Background(), test.transcript, testAnimals(), rand.New(rand.NewSource(1)))
			if err != nil {
				t.Fatal(err)
			}
			if selection.Strategy != strategyDirect || selection.Species != test.animalID {
				t.Fatalf("selection = %#v", selection)
			}
		})
	}
}

func TestAssociationDirectTieUsesLongestAlias(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	selection, err := engine.Select(context.Background(), "雄鶏が鳴いた", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "rooster" || selection.EvidenceTerm != "雄鶏" {
		t.Fatalf("selection = %#v", selection)
	}
}

func TestAssociationDoesNotTreatAnimalSubstringAsDirectMention(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "競馬場", AnimalID: "horse", Relation: "AtLocation", Weight: 1},
	}})
	selection, err := engine.Select(context.Background(), "競馬場でレースを見た", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Strategy != strategyConceptNet || selection.Species != "horse" {
		t.Fatalf("selection = %#v, want ConceptNet horse", selection)
	}
}

func TestAssociationDirectMentionMustExistLiterallyInTranscript(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})

	for _, transcript := range []string{"そろそろ帰る", "予定を変える"} {
		selection, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy == strategyDirect {
			t.Fatalf("%q selection = %#v, want non-direct fallback", transcript, selection)
		}
	}

	selection, err := engine.Select(context.Background(), "山と羊がいる", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Strategy != strategyDirect || selection.Species != "sheep" || selection.EvidenceTerm != "羊" {
		t.Fatalf("selection = %#v, want literal sheep mention", selection)
	}

	selection, err = engine.Select(context.Background(), "かえるが池で跳ねた", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Strategy != strategyDirect || selection.Species != "frog" || selection.EvidenceTerm != "かえる" {
		t.Fatalf("selection = %#v, want literal frog mention", selection)
	}
}

func TestAssociationLiteralTermsUseDirectOrPlayfulStrategy(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})

	for _, transcript := range []string{
		"明日は雨が降るかもしれない",
		"そろそろ帰るかも",
		"それでいいかもね",
		"明日は雨かもと思った",
		"疲れたかもと感じる",
		"間に合わないかもと不安になった",
		"雨かもの日",
		"モーターが壊れた",
	} {
		selection, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy == strategyDirect || selection.Strategy == strategyPun {
			t.Fatalf("%q selection = %#v, want ConceptNet or random fallback", transcript, selection)
		}
	}

	for _, test := range []struct {
		transcript        string
		animalID          string
		evidence          string
		allowedStrategies []SelectionStrategy
	}{
		{transcript: "鴨が池で泳いでいる", animalID: "duck", evidence: "鴨", allowedStrategies: []SelectionStrategy{strategyDirect}},
		{transcript: "かもが池で泳いでいる", animalID: "duck", evidence: "かも", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "象がゆっくり歩く", animalID: "elephant", evidence: "象", allowedStrategies: []SelectionStrategy{strategyDirect}},
		{transcript: "ぞうがゆっくり歩く", animalID: "elephant", evidence: "ぞう", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "昨日猫を見た", animalID: "cat", evidence: "猫", allowedStrategies: []SelectionStrategy{strategyDirect}},
		{transcript: "今日犬と散歩した", animalID: "dog", evidence: "犬", allowedStrategies: []SelectionStrategy{strategyDirect}},
		{transcript: "昨日牛を見た", animalID: "cow", evidence: "牛", allowedStrategies: []SelectionStrategy{strategyDirect}},
		{transcript: "動物園で象さんを見ました", animalID: "elephant", evidence: "象", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "猫カフェに行った", animalID: "cat", evidence: "猫", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "小さいねこがいる", animalID: "cat", evidence: "ねこ", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "大きいぞうがいた", animalID: "elephant", evidence: "ぞう", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "白いやぎがいる", animalID: "goat", evidence: "やぎ", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "かえるが池で跳ねた", animalID: "frog", evidence: "かえる", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "家にかえる", animalID: "frog", evidence: "かえる", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "かえるが、今日は予定がある", animalID: "frog", evidence: "かえる", allowedStrategies: []SelectionStrategy{strategyDirect, strategyPun}},
		{transcript: "うしろから声がした", animalID: "cow", evidence: "うし", allowedStrategies: []SelectionStrategy{strategyPun}},
		{transcript: "ぞうきんを絞る", animalID: "elephant", evidence: "ぞう", allowedStrategies: []SelectionStrategy{strategyPun}},
		{transcript: "増税されるぞう", animalID: "elephant", evidence: "ぞう", allowedStrategies: []SelectionStrategy{strategyPun}},
	} {
		selection, err := engine.Select(context.Background(), test.transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if !containsStrategy(test.allowedStrategies, selection.Strategy) ||
			selection.Species != test.animalID || selection.EvidenceTerm != test.evidence {
			t.Fatalf("%q selection = %#v, want animal=%s evidence=%q strategy in %v", test.transcript, selection, test.animalID, test.evidence, test.allowedStrategies)
		}
	}
}

func TestAssociationOnomatopoeiaUsesLiteralTokenBoundariesWithoutContextGuards(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	for _, test := range []struct {
		transcript string
		animalID   string
		evidence   string
	}{
		{transcript: "もーちょっと待って", animalID: "cow", evidence: "もー"},
		{transcript: "コロコロを買った", animalID: "cricket", evidence: "コロコロ"},
		{transcript: "話がころころ変わる", animalID: "cricket", evidence: "ころころ"},
		{transcript: "ころころ鳴く虫の声", animalID: "cricket", evidence: "ころころ"},
		{transcript: "にゃー！", animalID: "cat", evidence: "にゃー"},
	} {
		selection, err := engine.Select(context.Background(), test.transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy != strategyDirect || selection.Species != test.animalID || selection.EvidenceTerm != test.evidence {
			t.Fatalf("%q selection = %#v, want direct %s", test.transcript, selection, test.animalID)
		}
	}
}

func TestAssociationDirectOutranksEarlierPun(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	selection, err := engine.Select(context.Background(), "うしろを見てから犬と歩いた", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Strategy != strategyDirect || selection.Species != "dog" || selection.EvidenceTerm != "犬" {
		t.Fatalf("selection = %#v, want later direct dog to outrank earlier cow pun", selection)
	}
}

func TestTokenCandidatesExcludeParticlesAndOnlyJoinAdjacentContentTokens(t *testing.T) {
	terms := tokenizeAssociationTerms("牧場でミルクをしぼった")
	texts := make([]string, 0, len(terms))
	for _, term := range terms {
		texts = append(texts, term.Text)
	}
	for _, excluded := range []string{"で", "を", "た", "。"} {
		if containsString(texts, excluded) {
			t.Errorf("excluded token %q appears in %v", excluded, texts)
		}
	}
	for _, required := range []string{"牧場", "ミルク", "しぼる"} {
		if !containsString(texts, required) {
			t.Errorf("required candidate %q missing from %v", required, texts)
		}
	}
	for _, nonAdjacent := range []string{"牧場ミルク", "ミルクしぼっ"} {
		if containsString(texts, nonAdjacent) {
			t.Errorf("non-adjacent compound %q appears in %v", nonAdjacent, texts)
		}
	}

	separated := tokenizeAssociationTerms("山と羊がいる")
	separatedTexts := make([]string, 0, len(separated))
	for _, term := range separated {
		separatedTexts = append(separatedTexts, term.Text)
	}
	if containsString(separatedTexts, "山羊") {
		t.Fatalf("non-adjacent compound 山羊 appears in %v", separatedTexts)
	}

	adjacent := tokenizeAssociationTerms("牧場ミルク")
	adjacentTexts := make([]string, 0, len(adjacent))
	for _, term := range adjacent {
		adjacentTexts = append(adjacentTexts, term.Text)
	}
	if !containsString(adjacentTexts, "牧場ミルク") {
		t.Fatalf("adjacent compound 牧場ミルク missing from %v", adjacentTexts)
	}
	seen := make(map[string]bool)
	for _, text := range texts {
		if seen[text] {
			t.Fatalf("duplicate candidate %q in %v", text, texts)
		}
		seen[text] = true
	}
}

func TestAssociationConceptNetScoreAndTieBreaks(t *testing.T) {
	store := fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "牧場", AnimalID: "cow", Relation: "RelatedTo", Weight: 1.0},
		{Concept: "ミルク", AnimalID: "cow", Relation: "HasProperty", Weight: 1.0},
		{Concept: "牧場", AnimalID: "goat", Relation: "RelatedTo", Weight: 1.5},
		{Concept: "ミルク", AnimalID: "horse", Relation: "IsA", Weight: 2.0},
	}}
	engine := testAssociationEngine(t, store)
	selection, err := engine.Select(context.Background(), "牧場でミルクをしぼった", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	// cow = 1.0 + 0.6, goat = 1.5, horse = 1.0.
	if selection.Species != "cow" || selection.Strategy != strategyConceptNet || selection.EvidenceTerm != "牧場" {
		t.Fatalf("selection = %#v", selection)
	}
}

func TestAssociationConceptNetExactTieUsesEvidencePositionThenAnimalID(t *testing.T) {
	store := fakeCandidateStore{edges: []conceptindex.Edge{
		{Concept: "後半", AnimalID: "cat", Relation: "RelatedTo", Weight: 1},
		{Concept: "先頭", AnimalID: "dog", Relation: "RelatedTo", Weight: 1},
	}}
	engine := testAssociationEngine(t, store)
	selection, err := engine.Select(context.Background(), "先頭と後半", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "dog" {
		t.Fatalf("selection = %#v, want earlier dog evidence", selection)
	}

	store.edges = []conceptindex.Edge{
		{Concept: "先頭", AnimalID: "dog", Relation: "RelatedTo", Weight: 1},
		{Concept: "先頭", AnimalID: "cat", Relation: "RelatedTo", Weight: 1},
	}
	selection, err = engineWithStore(t, store).Select(context.Background(), "先頭", testAnimals(), rand.New(rand.NewSource(1)))
	if err != nil {
		t.Fatal(err)
	}
	if selection.Species != "cat" {
		t.Fatalf("selection = %#v, want lexical animal ID tie break", selection)
	}
}

func TestAssociationFallbackAndErrors(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	for _, transcript := range []string{"会議の資料を確認しました", "明日の予定を調整します", "パスワードを更新しました", "！？…"} {
		selection, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(7)))
		if err != nil {
			t.Fatalf("%q: %v", transcript, err)
		}
		if selection.Strategy != strategyRandom || selection.FallbackReason != fallbackNoMatch || selection.EvidenceTerm != "" {
			t.Fatalf("%q selection = %#v", transcript, selection)
		}
	}
	for _, transcript := range []string{"", "   \n"} {
		_, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(1)))
		var apiError *APIError
		if !errors.As(err, &apiError) || apiError.Code != "asr_empty" {
			t.Fatalf("%q error = %#v, want asr_empty", transcript, err)
		}
	}

	failed := testAssociationEngine(t, fakeCandidateStore{err: errors.New("database unavailable")})
	_, err := failed.Select(context.Background(), "散歩に行こう", testAnimals(), rand.New(rand.NewSource(1)))
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Code != "association_failed" {
		t.Fatalf("query error = %#v, want association_failed", err)
	}
}

func TestRelationMultipliers(t *testing.T) {
	want := map[string]float64{
		"RelatedTo": 1.0, "AtLocation": 1.0, "CapableOf": 0.9,
		"Desires": 0.8, "HasProperty": 0.6, "IsA": 0.5,
	}
	if !reflect.DeepEqual(relationMultipliers, want) {
		t.Fatalf("relationMultipliers = %#v, want %#v", relationMultipliers, want)
	}
}

type fakeCandidateStore struct {
	edges []conceptindex.Edge
	err   error
}

func (store fakeCandidateStore) Candidates(context.Context, []string) ([]conceptindex.Edge, error) {
	return store.edges, store.err
}

func testAssociationEngine(t *testing.T, store fakeCandidateStore) *associationEngine {
	t.Helper()
	return engineWithStore(t, store)
}

func engineWithStore(t *testing.T, store conceptCandidateStore) *associationEngine {
	t.Helper()
	engine, err := newAssociationEngine(filepath.Join("assets", "animal-lexicon.json"), store)
	if err != nil {
		t.Fatal(err)
	}
	return engine
}

func testAnimals() []availableAnimal {
	return []availableAnimal{
		{ID: "cat", LabelJA: "猫", Variants: []assetVariant{{Path: "cat.wav"}}},
		{ID: "cow", LabelJA: "牛", Variants: []assetVariant{{Path: "cow.wav"}}},
		{ID: "cricket", LabelJA: "蟋蟀", Variants: []assetVariant{{Path: "cricket.wav"}}},
		{ID: "dog", LabelJA: "犬", Variants: []assetVariant{{Path: "dog.wav"}}},
		{ID: "duck", LabelJA: "家鴨", Variants: []assetVariant{{Path: "duck.wav"}}},
		{ID: "elephant", LabelJA: "象", Variants: []assetVariant{{Path: "elephant.wav"}}},
		{ID: "frog", LabelJA: "蛙", Variants: []assetVariant{{Path: "frog.wav"}}},
		{ID: "goat", LabelJA: "山羊", Variants: []assetVariant{{Path: "goat.wav"}}},
		{ID: "horse", LabelJA: "馬", Variants: []assetVariant{{Path: "horse.wav"}}},
		{ID: "lion", LabelJA: "ライオン", Variants: []assetVariant{{Path: "lion.wav"}}},
		{ID: "pig", LabelJA: "ブタ", Variants: []assetVariant{{Path: "pig.wav"}}},
		{ID: "rooster", LabelJA: "鶏", Variants: []assetVariant{{Path: "rooster.wav"}}},
		{ID: "sheep", LabelJA: "羊", Variants: []assetVariant{{Path: "sheep.wav"}}},
	}
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func containsStrategy(values []SelectionStrategy, target SelectionStrategy) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
