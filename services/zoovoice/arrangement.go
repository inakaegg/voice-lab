package main

import (
	"fmt"
	"math/rand"
	"sort"
)

type resolvedSlot struct {
	name    string
	species *availableAnimal
}

func resolveArrangement(
	catalog *assetCatalog,
	settings ComposeSettings,
	gaps []SilenceInterval,
	inputDuration float64,
	rng *rand.Rand,
) ([]ResolvedInsertion, error) {
	intensity, err := mapIntensity(settings.Intensity)
	if err != nil {
		return nil, err
	}
	opening, err := resolveSlot(catalog, "opening", settings.Arrangement.Opening, rng)
	if err != nil {
		return nil, err
	}
	gapSlot, err := resolveSlot(catalog, "gaps", settings.Arrangement.Gaps, rng)
	if err != nil {
		return nil, err
	}
	ending, err := resolveSlot(catalog, "ending", settings.Arrangement.Ending, rng)
	if err != nil {
		return nil, err
	}

	candidates := make([]struct {
		slot   resolvedSlot
		atTime float64
	}, 0, len(gaps)+2)
	if opening.species != nil {
		candidates = append(candidates, struct {
			slot   resolvedSlot
			atTime float64
		}{slot: opening, atTime: 0})
	}
	if ending.species != nil {
		candidates = append(candidates, struct {
			slot   resolvedSlot
			atTime float64
		}{slot: ending, atTime: inputDuration})
	}
	if gapSlot.species != nil {
		for _, gap := range gaps {
			candidates = append(candidates, struct {
				slot   resolvedSlot
				atTime float64
			}{slot: gapSlot, atTime: gap.Start})
		}
	}
	if len(candidates) > intensity.MaxInsertions {
		candidates = candidates[:intensity.MaxInsertions]
	}

	insertions := make([]ResolvedInsertion, 0, len(candidates))
	for _, candidate := range candidates {
		animal := candidate.slot.species
		variant := animal.Variants[rng.Intn(len(animal.Variants))]
		insertions = append(insertions, ResolvedInsertion{
			Slot:      candidate.slot.name,
			Species:   animal.ID,
			AtSeconds: candidate.atTime,
			AssetPath: variant.Path,
		})
	}
	sort.SliceStable(insertions, func(i, j int) bool {
		return insertions[i].AtSeconds < insertions[j].AtSeconds
	})
	return insertions, nil
}

func resolveSlot(
	catalog *assetCatalog,
	name string,
	value *string,
	rng *rand.Rand,
) (resolvedSlot, error) {
	if value == nil {
		return resolvedSlot{name: name}, nil
	}
	if *value == "lucky" {
		animal := catalog.Animals[rng.Intn(len(catalog.Animals))]
		return resolvedSlot{name: name, species: &animal}, nil
	}
	animal, ok := catalog.byID[*value]
	if !ok {
		return resolvedSlot{}, fmt.Errorf("unknown species %q for %s", *value, name)
	}
	return resolvedSlot{name: name, species: &animal}, nil
}
