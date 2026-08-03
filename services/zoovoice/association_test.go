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

func TestAssociationAnimalTermRequiresLiteralContentUsage(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})

	for _, transcript := range []string{
		"明日は雨が降るかもしれない",
		"そろそろ帰るかも",
		"それでいいかもね",
		"明日は雨かもと思った",
		"疲れたかもと感じる",
		"間に合わないかもと不安になった",
		"雨かもの日",
		"増税されるぞう",
		"元気になるぞうと言った",
		"家にかえる",
		"かえるが、今日は予定がある",
		"うしろから声がした",
		"うしろを見た",
		"うしろの席",
		"ぞうきんを絞る",
	} {
		selection, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy == strategyDirect {
			t.Fatalf("%q selection = %#v, want non-direct fallback", transcript, selection)
		}
	}

	for _, test := range []struct {
		transcript string
		animalID   string
	}{
		{transcript: "鴨が池で泳いでいる", animalID: "duck"},
		{transcript: "かもが池で泳いでいる", animalID: "duck"},
		{transcript: "象がゆっくり歩く", animalID: "elephant"},
		{transcript: "ぞうがゆっくり歩く", animalID: "elephant"},
		{transcript: "昨日猫を見た", animalID: "cat"},
		{transcript: "今日犬と散歩した", animalID: "dog"},
		{transcript: "昨日牛を見た", animalID: "cow"},
		{transcript: "動物園で象さんを見ました", animalID: "elephant"},
		{transcript: "猫カフェに行った", animalID: "cat"},
		{transcript: "小さいねこがいる", animalID: "cat"},
		{transcript: "大きいぞうがいた", animalID: "elephant"},
		{transcript: "白いやぎがいる", animalID: "goat"},
	} {
		selection, err := engine.Select(context.Background(), test.transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy != strategyDirect || selection.Species != test.animalID {
			t.Fatalf("%q selection = %#v, want direct %s", test.transcript, selection, test.animalID)
		}
	}
}

func TestAssociationOnomatopoeiaRequiresAWholeTokenAndSoundContextWhenAmbiguous(t *testing.T) {
	engine := testAssociationEngine(t, fakeCandidateStore{})
	for _, transcript := range []string{
		"モーターが動いています",
		"もーちょっと待って",
		"コロコロを買った",
		"話がころころ変わる",
	} {
		selection, err := engine.Select(context.Background(), transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy == strategyDirect {
			t.Fatalf("%q selection = %#v, want non-direct fallback", transcript, selection)
		}
	}

	for _, test := range []struct {
		transcript string
		animalID   string
	}{
		{transcript: "ころころ鳴く虫の声", animalID: "cricket"},
		{transcript: "にゃー！", animalID: "cat"},
	} {
		selection, err := engine.Select(context.Background(), test.transcript, testAnimals(), rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatal(err)
		}
		if selection.Strategy != strategyDirect || selection.Species != test.animalID {
			t.Fatalf("%q selection = %#v, want direct %s", test.transcript, selection, test.animalID)
		}
	}
}

func TestTokenCandidatesExcludeParticlesAndIncludeFormsAndCompounds(t *testing.T) {
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
	for _, required := range []string{"牧場", "ミルク", "しぼる", "牧場ミルク"} {
		if !containsString(texts, required) {
			t.Errorf("required candidate %q missing from %v", required, texts)
		}
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
	engine, err := newAssociationEngine(filepath.Join("assets", "association-aliases.json"), store)
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
