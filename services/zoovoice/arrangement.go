package main

import (
	"fmt"
	"math/rand"
	"sort"
)

func resolveArrangement(
	catalog *assetCatalog,
	selectedSpecies string,
	intensityValue int,
	gaps []SilenceInterval,
	inputDuration float64,
	rng *rand.Rand,
) ([]ResolvedInsertion, error) {
	intensity, err := mapIntensity(intensityValue)
	if err != nil {
		return nil, err
	}
	animal, ok := catalog.byID[selectedSpecies]
	if !ok || len(animal.Variants) == 0 {
		return nil, fmt.Errorf("selected animal %q is unavailable", selectedSpecies)
	}

	type insertionCandidate struct {
		slot     string
		atSecond float64
	}
	candidates := make([]insertionCandidate, 0, len(gaps)+2)
	// Opening and ending are selected before gaps so low intensity keeps both anchors.
	candidates = append(candidates,
		insertionCandidate{slot: "opening", atSecond: 0},
		insertionCandidate{slot: "ending", atSecond: inputDuration},
	)
	for _, gap := range gaps {
		candidates = append(candidates, insertionCandidate{slot: "gaps", atSecond: gap.Start})
	}
	if len(candidates) > intensity.MaxInsertions {
		candidates = candidates[:intensity.MaxInsertions]
	}

	insertions := make([]ResolvedInsertion, 0, len(candidates))
	for _, candidate := range candidates {
		variant := animal.Variants[rng.Intn(len(animal.Variants))]
		insertions = append(insertions, ResolvedInsertion{
			Slot:      candidate.slot,
			Species:   animal.ID,
			AtSeconds: candidate.atSecond,
			AssetPath: variant.Path,
		})
	}
	sort.SliceStable(insertions, func(i, j int) bool {
		return insertions[i].AtSeconds < insertions[j].AtSeconds
	})
	return insertions, nil
}
