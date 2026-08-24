package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func testBoundaries(count int) []wordBoundary {
	boundaries := make([]wordBoundary, count)
	for index := range boundaries {
		boundaries[index] = wordBoundary{RuneIndex: index + 1, AtSeconds: float64(index + 1)}
	}
	return boundaries
}

func TestResolveArrangementFillsWordBoundariesAndAlwaysEndsWithOne(t *testing.T) {
	const inputDuration = 20.0
	for _, test := range []struct {
		intensity int
		wantCount int
	}{
		{intensity: 0, wantCount: 1},
		{intensity: 50, wantCount: 6},
		{intensity: 100, wantCount: 11},
	} {
		t.Run(fmt.Sprintf("intensity_%d", test.intensity), func(t *testing.T) {
			got, err := resolveArrangement(
				testCatalog(),
				[]string{"dog"},
				test.intensity,
				testBoundaries(12),
				inputDuration,
				rand.New(rand.NewSource(1)),
			)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != test.wantCount {
				t.Fatalf("insertions = %d, want %d: %#v", len(got), test.wantCount, got)
			}
			for index, insertion := range got {
				if insertion.Species != "dog" {
					t.Errorf("insertion[%d] species = %q", index, insertion.Species)
				}
				if index > 0 && insertion.AtSeconds < got[index-1].AtSeconds {
					t.Errorf("insertions are not sorted: %#v", got)
				}
			}
			// 先頭には入れない。末尾は必ず入れる。
			if got[0].AtSeconds <= 0 {
				t.Errorf("an insertion landed on the opening: %#v", got)
			}
			last := got[len(got)-1]
			if last.Slot != slotEnding || last.AtSeconds != inputDuration {
				t.Errorf("ending insertion = %+v", last)
			}
			for _, insertion := range got[:len(got)-1] {
				if insertion.Slot != slotWord || insertion.DurationSeconds != wordInsertionSeconds {
					t.Errorf("word insertion = %+v", insertion)
				}
			}
			if last.DurationSeconds != endingInsertionSeconds {
				t.Errorf("ending duration = %v", last.DurationSeconds)
			}
		})
	}
}

// 一形態素だけの発話など、単語の切れ目が無い入力でも失敗させない。
func TestResolveArrangementKeepsEndingWithoutBoundaries(t *testing.T) {
	got, err := resolveArrangement(
		testCatalog(), []string{"dog"}, 100, nil, 1.2, rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Slot != slotEnding || got[0].AtSeconds != 1.2 {
		t.Fatalf("insertions = %#v", got)
	}
}

func TestResolveArrangementAlternatesSpeciesAndEndsWithTheFirst(t *testing.T) {
	got, err := resolveArrangement(
		testCatalog(),
		[]string{"dog", "cat"},
		100,
		testBoundaries(12),
		20,
		rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"dog", "cat", "dog", "cat", "dog", "cat", "dog", "cat", "dog", "cat", "dog"}
	if len(got) != len(want) {
		t.Fatalf("insertions = %d, want %d: %#v", len(got), len(want), got)
	}
	for index, species := range want {
		if got[index].Species != species {
			t.Fatalf("species = %#v, want %#v", speciesOf(got), want)
		}
	}
}

func TestResolveArrangementUsesBothSpeciesWithOneWordAndEnding(t *testing.T) {
	got, err := resolveArrangement(
		testCatalog(),
		[]string{"dog", "cat"},
		50,
		[]wordBoundary{{RuneIndex: 1, AtSeconds: 1.8}},
		3.9,
		rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"cat", "dog"}
	if fmt.Sprint(speciesOf(got)) != fmt.Sprint(want) {
		t.Fatalf("species = %#v, want %#v", speciesOf(got), want)
	}
}

func TestResolveArrangementRejectsUnknownOrMissingAnimal(t *testing.T) {
	for _, species := range [][]string{{"unicorn"}, {"dog", "unicorn"}, nil} {
		if _, err := resolveArrangement(
			testCatalog(), species, 50, nil, 2, rand.New(rand.NewSource(1)),
		); err == nil {
			t.Errorf("accepted species %#v", species)
		}
	}
}

// 末尾の挿入とぶつかる位置は文中の候補から外す。
func TestResolveArrangementDropsBoundariesTooCloseToTheEnd(t *testing.T) {
	got, err := resolveArrangement(
		testCatalog(),
		[]string{"dog"},
		100,
		[]wordBoundary{{RuneIndex: 1, AtSeconds: 1.9}},
		2.0,
		rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Slot != slotEnding {
		t.Fatalf("insertions = %#v", got)
	}
}

func TestSelectEvenlySpreadsCandidatesAndKeepsMinimumGap(t *testing.T) {
	spread := selectEvenly(testBoundaries(12), 3)
	if len(spread) != 3 {
		t.Fatalf("selected = %#v", spread)
	}
	for index := 1; index < len(spread); index++ {
		if spread[index].AtSeconds-spread[index-1].AtSeconds < minimumInsertionGapSeconds {
			t.Fatalf("selected candidates are too close: %#v", spread)
		}
	}
	// 候補より多く要求されても、候補数を超えない。
	if all := selectEvenly(testBoundaries(2), 5); len(all) != 2 {
		t.Fatalf("selected = %#v", all)
	}
	// 近すぎる候補ばかりなら、選ばれる数は減る。
	dense := []wordBoundary{{AtSeconds: 1.0}, {AtSeconds: 1.1}, {AtSeconds: 1.2}}
	if got := selectEvenly(dense, 3); len(got) != 1 {
		t.Fatalf("selected = %#v", got)
	}
	if got := selectEvenly(nil, 3); got != nil {
		t.Fatalf("selected = %#v", got)
	}
	if got := selectEvenly(testBoundaries(3), 0); got != nil {
		t.Fatalf("selected = %#v", got)
	}
}

func speciesOf(insertions []ResolvedInsertion) []string {
	species := make([]string, 0, len(insertions))
	for _, insertion := range insertions {
		species = append(species, insertion.Species)
	}
	return species
}

func testCatalog() *assetCatalog {
	animals := []availableAnimal{
		{ID: "cat", LabelJA: "猫", Variants: []assetVariant{{Path: "cat.wav"}}},
		{ID: "cow", LabelJA: "牛", Variants: []assetVariant{{Path: "cow.wav"}}},
		{ID: "dog", LabelJA: "犬", Variants: []assetVariant{{Path: "dog.wav"}}},
	}
	byID := make(map[string]availableAnimal, len(animals))
	for _, animal := range animals {
		byID[animal.ID] = animal
	}
	return &assetCatalog{Animals: animals, byID: byID}
}
