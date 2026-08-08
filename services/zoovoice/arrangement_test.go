package main

import (
	"fmt"
	"math/rand"
	"testing"
)

func TestResolveArrangementUsesSelectedAnimalAtEverySlot(t *testing.T) {
	for _, test := range []struct {
		intensity int
		wantCount int
	}{
		{intensity: 0, wantCount: 2},
		{intensity: 50, wantCount: 6},
		{intensity: 100, wantCount: 10},
	} {
		t.Run(fmt.Sprintf("intensity_%d", test.intensity), func(t *testing.T) {
			gaps := make([]SilenceInterval, 12)
			for index := range gaps {
				gaps[index] = SilenceInterval{Start: float64(index + 1), End: float64(index+1) + 0.5}
			}
			got, err := resolveArrangement(
				testCatalog(),
				"dog",
				test.intensity,
				gaps,
				20,
				rand.New(rand.NewSource(1)),
			)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != test.wantCount {
				t.Fatalf("intensity %d insertions = %d, want %d: %#v", test.intensity, len(got), test.wantCount, got)
			}
			for index, insertion := range got {
				if insertion.Species != "dog" {
					t.Errorf("insertion[%d] species = %q", index, insertion.Species)
				}
				if index > 0 && insertion.AtSeconds < got[index-1].AtSeconds {
					t.Errorf("insertions are not sorted: %#v", got)
				}
			}
			if got[0].Slot != "opening" || got[len(got)-1].Slot != "ending" {
				t.Errorf("opening/ending priority missing: %#v", got)
			}
		})
	}
}

func TestResolveArrangementRejectsUnknownSelectedAnimal(t *testing.T) {
	_, err := resolveArrangement(
		testCatalog(),
		"unicorn",
		50,
		nil,
		2,
		rand.New(rand.NewSource(1)),
	)
	if err == nil {
		t.Fatal("unknown selected animal accepted")
	}
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
