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

// assetCatalog は音源カタログ。動物IDと鳴き声素材の対応だけを持ち、
// 連想の知識は持たない（連想はLLMが候補リストから選ぶ）。
type assetCatalog struct {
	Animals      []availableAnimal
	byID         map[string]availableAnimal
	creditByPath map[string]soundCredit
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
// 各ファイルのSHA-256一致を必須にする。
func loadSoundsCatalog(soundsDir string) (*assetCatalog, error) {
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
	animals := make([]availableAnimal, 0, len(manifest.Animals))
	for _, animal := range manifest.Animals {
		if animal.ID == "" || animal.LabelJA == "" || len(animal.Files) == 0 {
			return nil, fmt.Errorf("sounds manifest %s has an entry without id, label or files", manifestPath)
		}
		variants := make([]assetVariant, 0, len(animal.Files))
		for _, file := range animal.Files {
			if file.License == "" {
				return nil, fmt.Errorf("sounds manifest entry %q has a file without license", animal.ID)
			}
			path, err := verifiedAssetPath(soundsDir, animal.ID, file.File, file.SHA256)
			if err != nil {
				return nil, err
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
		animals = append(animals, availableAnimal{ID: animal.ID, LabelJA: animal.LabelJA, Variants: variants})
	}
	return newCatalog(animals), nil
}

// 旧スキーマ: assets/animal-sounds/manifest.json（1動物1ファイル、
// クレジットを動物単位で持つ）。
type legacySoundsManifest struct {
	Animals []struct {
		ID         string `json:"id"`
		LabelJA    string `json:"label_ja"`
		File       string `json:"file"`
		SHA256     string `json:"normalized_sha256"`
		License    string `json:"license"`
		Creator    string `json:"creator"`
		LandingURL string `json:"landing_url"`
	} `json:"animals"`
}

// loadLegacyCatalog は同梱の assets/animal-sounds/ からカタログを作る。
func loadLegacyCatalog(assetsRoot string) (*assetCatalog, error) {
	soundsDir := filepath.Join(assetsRoot, "animal-sounds")
	manifestPath := filepath.Join(soundsDir, "manifest.json")
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read sounds manifest: %w", err)
	}
	var manifest legacySoundsManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, fmt.Errorf("parse sounds manifest %s: %w", manifestPath, err)
	}
	if len(manifest.Animals) == 0 {
		return nil, fmt.Errorf("sounds manifest %s has no animals", manifestPath)
	}
	animals := make([]availableAnimal, 0, len(manifest.Animals))
	for _, animal := range manifest.Animals {
		if animal.ID == "" || animal.LabelJA == "" || animal.File == "" || animal.License == "" {
			return nil, fmt.Errorf("sounds manifest %s has an incomplete entry", manifestPath)
		}
		path, err := verifiedAssetPath(soundsDir, animal.ID, animal.File, animal.SHA256)
		if err != nil {
			return nil, err
		}
		animals = append(animals, availableAnimal{
			ID: animal.ID, LabelJA: animal.LabelJA,
			Variants: []assetVariant{{
				Path: path,
				Credit: soundCredit{
					License:   animal.License,
					Creator:   animal.Creator,
					SourceURL: animal.LandingURL,
				},
			}},
		})
	}
	return newCatalog(animals), nil
}

// verifiedAssetPath は manifest記載の相対パスを検証し、SHA-256の一致を確かめる。
func verifiedAssetPath(soundsDir, animalID, file, expectedSHA string) (string, error) {
	relative := filepath.FromSlash(file)
	if filepath.IsAbs(relative) || strings.HasPrefix(relative, "..") || filepath.Clean(relative) != relative {
		return "", fmt.Errorf("sounds manifest entry %q has invalid file path %q", animalID, file)
	}
	path := filepath.Join(soundsDir, relative)
	if !regularFileExists(path) {
		return "", fmt.Errorf("animal %q audio is missing: %s", animalID, file)
	}
	actualSHA, err := fileSHA256(path)
	if err != nil {
		return "", fmt.Errorf("hash animal %q audio: %w", animalID, err)
	}
	if actualSHA != strings.ToLower(expectedSHA) {
		return "", fmt.Errorf("animal %q audio SHA-256 mismatch: %s", animalID, file)
	}
	return path, nil
}

func newCatalog(animals []availableAnimal) *assetCatalog {
	sort.Slice(animals, func(i, j int) bool { return animals[i].ID < animals[j].ID })
	catalog := &assetCatalog{
		Animals:      animals,
		byID:         make(map[string]availableAnimal, len(animals)),
		creditByPath: make(map[string]soundCredit),
	}
	for _, animal := range animals {
		catalog.byID[animal.ID] = animal
		for _, variant := range animal.Variants {
			catalog.creditByPath[variant.Path] = variant.Credit
		}
	}
	return catalog
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
