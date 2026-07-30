package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

type animalDefinition struct {
	ID      string        `json:"id"`
	LabelJA string        `json:"label_ja"`
	Sources []assetSource `json:"sources"`
}

type assetSource struct {
	Dir  string `json:"dir"`
	File string `json:"file"`
}

type assetVariant struct {
	Path string
}

type availableAnimal struct {
	ID       string
	LabelJA  string
	Variants []assetVariant
}

type assetCatalog struct {
	Animals []availableAnimal
	byID    map[string]availableAnimal
}

func loadCatalog(
	masterPath string,
	cc0Dir string,
	extraDir string,
	logger *log.Logger,
) (*assetCatalog, error) {
	payload, err := os.ReadFile(masterPath)
	if err != nil {
		return nil, fmt.Errorf("read animal master: %w", err)
	}
	var definitions []animalDefinition
	if err := json.Unmarshal(payload, &definitions); err != nil {
		return nil, fmt.Errorf("parse animal master: %w", err)
	}

	extraAvailable := directoryExists(extraDir)
	if !extraAvailable {
		logger.Printf("warning: extra assets are unavailable; starting with CC0 assets only")
	}

	catalog := &assetCatalog{
		Animals: make([]availableAnimal, 0, len(definitions)),
		byID:    make(map[string]availableAnimal, len(definitions)),
	}
	for _, definition := range definitions {
		if definition.ID == "" || definition.LabelJA == "" {
			return nil, fmt.Errorf("animal id and label_ja are required")
		}
		if _, exists := catalog.byID[definition.ID]; exists {
			return nil, fmt.Errorf("duplicate animal id %q", definition.ID)
		}
		animal := availableAnimal{
			ID:       definition.ID,
			LabelJA:  definition.LabelJA,
			Variants: make([]assetVariant, 0, len(definition.Sources)),
		}
		for _, source := range definition.Sources {
			if filepath.Base(source.File) != source.File || source.File == "." {
				return nil, fmt.Errorf("animal %q has invalid asset file %q", definition.ID, source.File)
			}
			var directory string
			switch source.Dir {
			case "cc0":
				directory = cc0Dir
			case "extra":
				if !extraAvailable {
					continue
				}
				directory = extraDir
			default:
				return nil, fmt.Errorf("animal %q has invalid asset dir %q", definition.ID, source.Dir)
			}
			path := filepath.Join(directory, source.File)
			if regularFileExists(path) {
				animal.Variants = append(animal.Variants, assetVariant{Path: path})
			}
		}
		if len(animal.Variants) == 0 {
			continue
		}
		catalog.Animals = append(catalog.Animals, animal)
		catalog.byID[animal.ID] = animal
	}
	if len(catalog.Animals) == 0 {
		return nil, fmt.Errorf("animal catalog has no available audio assets")
	}
	return catalog, nil
}

func (catalog *assetCatalog) publicAnimals() []AnimalSummary {
	summaries := make([]AnimalSummary, 0, len(catalog.Animals))
	for _, animal := range catalog.Animals {
		summaries = append(summaries, AnimalSummary{
			ID:       animal.ID,
			LabelJA:  animal.LabelJA,
			Variants: len(animal.Variants),
		})
	}
	return summaries
}

func directoryExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func regularFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
