package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/animaldefs"
)

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

func loadCatalog(lexiconPath, assetsRoot string) (*assetCatalog, error) {
	lexicon, err := animaldefs.Load(lexiconPath)
	if err != nil {
		return nil, err
	}
	catalog := &assetCatalog{
		Animals: make([]availableAnimal, 0, len(lexicon)),
		byID:    make(map[string]availableAnimal, len(lexicon)),
	}
	for _, id := range lexicon.IDs() {
		definition := lexicon[id]
		if filepath.IsAbs(definition.AudioFile) || filepath.Clean(definition.AudioFile) != definition.AudioFile || definition.AudioFile == "." || definition.AudioFile == ".." || filepath.Dir(definition.AudioFile) == ".." {
			return nil, fmt.Errorf("animal %q has invalid audio file %q", id, definition.AudioFile)
		}
		path := filepath.Join(assetsRoot, filepath.FromSlash(definition.AudioFile))
		if !regularFileExists(path) {
			return nil, fmt.Errorf("animal %q audio is missing: %s", id, definition.AudioFile)
		}
		actualSHA, err := fileSHA256(path)
		if err != nil {
			return nil, fmt.Errorf("hash animal %q audio: %w", id, err)
		}
		if actualSHA != definition.AudioSHA256 {
			return nil, fmt.Errorf("animal %q audio SHA-256 mismatch", id)
		}
		animal := availableAnimal{
			ID: id, LabelJA: definition.LabelJA,
			Variants: []assetVariant{{Path: path}},
		}
		catalog.Animals = append(catalog.Animals, animal)
		catalog.byID[id] = animal
	}
	if err := lexicon.ValidateAvailable(catalog.ids()); err != nil {
		return nil, err
	}
	return catalog, nil
}

func (catalog *assetCatalog) ids() []string {
	ids := make([]string, 0, len(catalog.Animals))
	for _, animal := range catalog.Animals {
		ids = append(ids, animal.ID)
	}
	return ids
}

func (catalog *assetCatalog) publicAnimals() []AnimalSummary {
	summaries := make([]AnimalSummary, 0, len(catalog.Animals))
	for _, animal := range catalog.Animals {
		summaries = append(summaries, AnimalSummary{
			ID: animal.ID, LabelJA: animal.LabelJA, Variants: len(animal.Variants),
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

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
