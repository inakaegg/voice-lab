package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/animaldefs"
)

type assetVariant struct {
	Path   string
	Credit soundCredit
}

type availableAnimal struct {
	ID       string
	LabelJA  string
	Variants []assetVariant
}

type assetCatalog struct {
	Animals []availableAnimal
	// UnusedSoundAnimals は音源manifestにあるが動物レキシコンに無い動物ID。
	// 語彙が未整備のため連想では選ばれない。
	UnusedSoundAnimals []string
	byID               map[string]availableAnimal
	creditByPath       map[string]soundCredit
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

// 最終セットのmanifest（tmp1/final/manifest.json と同スキーマ）。
// 1動物に複数ファイルを持ち、ファイル単位でクレジットとSHA-256を持つ。
type soundsManifest struct {
	SchemaVersion int `json:"schema_version"`
	Animals       []struct {
		ID      string `json:"id"`
		LabelJA string `json:"label_ja"`
		Files   []struct {
			File      string `json:"file"`
			License   string `json:"license"`
			Creator   string `json:"creator"`
			SourceURL string `json:"source_url"`
			SHA256    string `json:"sha256"`
		} `json:"files"`
	} `json:"animals"`
}

// loadSoundsCatalog は manifest付き音源ディレクトリからカタログを作る。
// レキシコンの全動物に音源があることと、各ファイルのSHA-256一致を必須にする。
func loadSoundsCatalog(lexiconPath, soundsDir string) (*assetCatalog, error) {
	lexicon, err := animaldefs.Load(lexiconPath)
	if err != nil {
		return nil, err
	}
	manifestPath := filepath.Join(soundsDir, "manifest.json")
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read sounds manifest: %w", err)
	}
	var manifest soundsManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, fmt.Errorf("parse sounds manifest %s: %w", manifestPath, err)
	}
	if manifest.SchemaVersion != 1 || len(manifest.Animals) == 0 {
		return nil, fmt.Errorf("sounds manifest %s is invalid", manifestPath)
	}
	variantsByID := make(map[string][]assetVariant, len(manifest.Animals))
	unused := make([]string, 0)
	for _, animal := range manifest.Animals {
		if animal.ID == "" || len(animal.Files) == 0 {
			return nil, fmt.Errorf("sounds manifest %s has an entry without id or files", manifestPath)
		}
		if _, inLexicon := lexicon[animal.ID]; !inLexicon {
			unused = append(unused, animal.ID)
			continue
		}
		variants := make([]assetVariant, 0, len(animal.Files))
		for _, file := range animal.Files {
			if file.License == "" {
				return nil, fmt.Errorf("sounds manifest entry %q has a file without license", animal.ID)
			}
			relative := filepath.FromSlash(file.File)
			if filepath.IsAbs(relative) || strings.HasPrefix(relative, "..") {
				return nil, fmt.Errorf("sounds manifest entry %q has invalid file path %q", animal.ID, file.File)
			}
			path := filepath.Join(soundsDir, relative)
			if !regularFileExists(path) {
				return nil, fmt.Errorf("animal %q audio is missing: %s", animal.ID, file.File)
			}
			actualSHA, err := fileSHA256(path)
			if err != nil {
				return nil, fmt.Errorf("hash animal %q audio: %w", animal.ID, err)
			}
			if actualSHA != strings.ToLower(file.SHA256) {
				return nil, fmt.Errorf("animal %q audio SHA-256 mismatch: %s", animal.ID, file.File)
			}
			variants = append(variants, assetVariant{
				Path: path,
				Credit: soundCredit{
					License:   file.License,
					Creator:   file.Creator,
					SourceURL: file.SourceURL,
				},
			})
		}
		variantsByID[animal.ID] = variants
	}
	sort.Strings(unused)
	catalog := &assetCatalog{
		Animals:            make([]availableAnimal, 0, len(lexicon)),
		UnusedSoundAnimals: unused,
		byID:               make(map[string]availableAnimal, len(lexicon)),
	}
	for _, id := range lexicon.IDs() {
		variants, found := variantsByID[id]
		if !found {
			return nil, fmt.Errorf("animal lexicon entry %q has no available audio", id)
		}
		animal := availableAnimal{ID: id, LabelJA: lexicon[id].LabelJA, Variants: variants}
		catalog.Animals = append(catalog.Animals, animal)
		catalog.byID[id] = animal
	}
	catalog.rebuildCreditIndex()
	return catalog, nil
}

func (catalog *assetCatalog) rebuildCreditIndex() {
	catalog.creditByPath = make(map[string]soundCredit)
	for _, animal := range catalog.Animals {
		for _, variant := range animal.Variants {
			catalog.creditByPath[variant.Path] = variant.Credit
		}
	}
}

// creditsForPaths は使用した素材パス群のクレジットを重複なしで返す。
func (catalog *assetCatalog) creditsForPaths(paths []string) []soundCredit {
	credits := make([]soundCredit, 0, len(paths))
	seen := make(map[soundCredit]bool, len(paths))
	for _, path := range paths {
		credit, found := catalog.creditByPath[path]
		if !found || seen[credit] {
			continue
		}
		seen[credit] = true
		credits = append(credits, credit)
	}
	return credits
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
