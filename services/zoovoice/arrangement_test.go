package main

import (
	"math/rand"
	"testing"
)

func TestResolveArrangementPrioritizesOpeningAndEndingAtLowIntensity(t *testing.T) {
	catalog := testCatalog()
	opening := "dog"
	gaps := "cow"
	ending := "cat"
	settings := ComposeSettings{
		Arrangement: Arrangement{Opening: &opening, Gaps: &gaps, Ending: &ending},
		Intensity:   0,
	}

	got, err := resolveArrangement(
		catalog,
		settings,
		[]SilenceInterval{{Start: 1, End: 2}, {Start: 3, End: 4}},
		5,
		rand.New(rand.NewSource(1)),
	)
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 2 {
		t.Fatalf("insertions = %#v, want opening and ending only", got)
	}
	if got[0].Slot != "opening" || got[0].Species != "dog" || got[0].AtSeconds != 0 {
		t.Errorf("opening = %#v", got[0])
	}
	if got[1].Slot != "ending" || got[1].Species != "cat" || got[1].AtSeconds != 5 {
		t.Errorf("ending = %#v", got[1])
	}
}

func TestResolveArrangementUsesOneIndependentLuckyChoicePerSlot(t *testing.T) {
	catalog := testCatalog()
	lucky := "lucky"
	settings := ComposeSettings{
		Arrangement: Arrangement{Opening: &lucky, Gaps: &lucky},
		Intensity:   100,
	}

	got, err := resolveArrangement(
		catalog,
		settings,
		[]SilenceInterval{{Start: 1, End: 2}, {Start: 3, End: 4}},
		5,
		rand.New(rand.NewSource(7)),
	)
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != 3 {
		t.Fatalf("insertions = %#v, want opening and two gaps", got)
	}
	if got[0].Species != "dog" {
		t.Errorf("seeded opening species = %q, want dog", got[0].Species)
	}
	if got[1].Species != "cat" || got[2].Species != "cat" {
		t.Errorf("seeded gaps species = %q/%q, want one cat choice reused for the gaps slot", got[1].Species, got[2].Species)
	}
}

func TestResolveArrangementRejectsUnknownSpecies(t *testing.T) {
	catalog := testCatalog()
	unknown := "unicorn"

	_, err := resolveArrangement(
		catalog,
		ComposeSettings{Arrangement: Arrangement{Opening: &unknown}, Intensity: 50},
		nil,
		2,
		rand.New(rand.NewSource(1)),
	)

	if err == nil {
		t.Fatal("unknown species accepted")
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
