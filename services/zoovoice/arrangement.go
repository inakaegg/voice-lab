package main

import (
	"fmt"
	"math/rand"
	"sort"
)

// 差し込む鳴き声の長さ。素材は中央値2.3秒・最長5.4秒あり、そのまま差し込むと発話が途切れすぎる。
// 実音声を聴いて決め直す前提の初期値。
const (
	wordInsertionSeconds   = 0.8
	endingInsertionSeconds = 2.5
	// 近すぎる挿入は1つの長い鳴き声に聞こえてしまうので、この間隔は空ける。
	minimumInsertionGapSeconds = 0.5
)

// resolveArrangement は鳴き声を差し込む位置を決める。
// 文中は単語の切れ目からアニマル度に応じた数だけ等間隔で選び、末尾には必ず1つ入れる。
// 単語の切れ目が無い短い発話でも失敗させず、末尾の1つだけを返す。
func resolveArrangement(
	catalog *assetCatalog,
	species []string,
	intensityValue int,
	boundaries []wordBoundary,
	inputDuration float64,
	rng *rand.Rand,
) ([]ResolvedInsertion, error) {
	if err := validateIntensity(intensityValue); err != nil {
		return nil, err
	}
	animals, err := selectedAnimals(catalog, species)
	if err != nil {
		return nil, err
	}

	// 末尾の挿入とぶつかる位置は文中の候補から外す。
	usable := make([]wordBoundary, 0, len(boundaries))
	for _, boundary := range boundaries {
		if boundary.AtSeconds <= inputDuration-minimumInsertionGapSeconds {
			usable = append(usable, boundary)
		}
	}

	wordInsertionCount := targetWordInsertionCount(inputDuration, intensityValue)
	selectedBoundaries := selectEvenly(usable, wordInsertionCount)
	insertions := make([]ResolvedInsertion, 0, len(selectedBoundaries)+1)
	// 末尾を1種目に固定したうえで交互配置を連続させる。
	// 文中が1枠だけでも2種目→1種目となり、選んだ2種を両方使える。
	wordSpeciesOffset := (len(animals) - len(selectedBoundaries)%len(animals)) % len(animals)
	for index, boundary := range selectedBoundaries {
		insertions = append(insertions, newInsertion(
			animals[(index+wordSpeciesOffset)%len(animals)], slotWord, boundary.AtSeconds, wordInsertionSeconds, rng,
		))
	}
	// 末尾はアニマル度に関わらず必ず入れる。動物は1種目を使う。
	insertions = append(insertions, newInsertion(
		animals[0], slotEnding, inputDuration, endingInsertionSeconds, rng,
	))
	sort.SliceStable(insertions, func(i, j int) bool {
		return insertions[i].AtSeconds < insertions[j].AtSeconds
	})
	return insertions, nil
}

func selectedAnimals(catalog *assetCatalog, species []string) ([]availableAnimal, error) {
	if len(species) == 0 {
		return nil, fmt.Errorf("no animal was selected")
	}
	animals := make([]availableAnimal, 0, len(species))
	for _, id := range species {
		animal, ok := catalog.byID[id]
		if !ok || len(animal.Variants) == 0 {
			return nil, fmt.Errorf("selected animal %q is unavailable", id)
		}
		animals = append(animals, animal)
	}
	return animals, nil
}

func newInsertion(
	animal availableAnimal,
	slot string,
	atSeconds float64,
	durationSeconds float64,
	rng *rand.Rand,
) ResolvedInsertion {
	variant := animal.Variants[rng.Intn(len(animal.Variants))]
	return ResolvedInsertion{
		Slot:            slot,
		Species:         animal.ID,
		AtSeconds:       atSeconds,
		DurationSeconds: durationSeconds,
		AssetPath:       variant.Path,
	}
}

// selectEvenly は候補列から最大count個を等間隔で選ぶ。
// 前寄り・後ろ寄りに固まらないよう、区間の真ん中の候補を取る。
// 直前に選んだ位置と近すぎるものは落とすので、返る数はcountより少なくなることがある。
func selectEvenly(boundaries []wordBoundary, count int) []wordBoundary {
	if count <= 0 || len(boundaries) == 0 {
		return nil
	}
	if count > len(boundaries) {
		count = len(boundaries)
	}
	selected := make([]wordBoundary, 0, count)
	previousSeconds := 0.0
	for index := 0; index < count; index++ {
		candidate := boundaries[(2*index+1)*len(boundaries)/(2*count)]
		if len(selected) > 0 && candidate.AtSeconds-previousSeconds < minimumInsertionGapSeconds {
			continue
		}
		selected = append(selected, candidate)
		previousSeconds = candidate.AtSeconds
	}
	return selected
}
