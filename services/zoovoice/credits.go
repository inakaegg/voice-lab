package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// 鳴き声素材1ファイル分の出典表示。音源manifestを正とする。
type soundCredit struct {
	License   string `json:"license"`
	Creator   string `json:"creator,omitempty"`
	SourceURL string `json:"source_url,omitempty"`
}

// 1行のクレジット表記。空の項目は落とす。
func (credit soundCredit) Line() string {
	parts := []string{credit.License}
	if credit.Creator != "" {
		parts = append(parts, credit.Creator)
	}
	if credit.SourceURL != "" {
		parts = append(parts, credit.SourceURL)
	}
	return strings.Join(parts, " / ")
}

// 旧スキーマ: assets/animal-sounds/manifest.json（1動物1ファイル、
// license・creator・landing_url を動物単位で持つ）。
type legacyCreditManifest struct {
	Animals []struct {
		ID         string `json:"id"`
		License    string `json:"license"`
		Creator    string `json:"creator"`
		LandingURL string `json:"landing_url"`
	} `json:"animals"`
}

// loadLegacyCredits は旧スキーマのmanifestから動物ID別のクレジットを読む。
func loadLegacyCredits(manifestPath string) (map[string]soundCredit, error) {
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read sound credits: %w", err)
	}
	var manifest legacyCreditManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, fmt.Errorf("parse sound credits %s: %w", manifestPath, err)
	}
	if len(manifest.Animals) == 0 {
		return nil, fmt.Errorf("sound credits %s has no animals", manifestPath)
	}
	credits := make(map[string]soundCredit, len(manifest.Animals))
	for _, animal := range manifest.Animals {
		if animal.ID == "" || animal.License == "" {
			return nil, fmt.Errorf("sound credits %s has an entry without id or license", manifestPath)
		}
		credits[animal.ID] = soundCredit{
			License:   animal.License,
			Creator:   animal.Creator,
			SourceURL: animal.LandingURL,
		}
	}
	return credits, nil
}

// attachLegacyCredits は旧レイアウトのカタログ全variantへクレジットを付ける。
// クレジットの無い動物は許さない（素材は必ず出典を持つ）。
func attachLegacyCredits(catalog *assetCatalog, manifestPath string) error {
	credits, err := loadLegacyCredits(manifestPath)
	if err != nil {
		return err
	}
	for index, animal := range catalog.Animals {
		credit, found := credits[animal.ID]
		if !found {
			return fmt.Errorf("animal %q has no sound credit in %s", animal.ID, manifestPath)
		}
		for variantIndex := range animal.Variants {
			animal.Variants[variantIndex].Credit = credit
		}
		catalog.Animals[index] = animal
		catalog.byID[animal.ID] = animal
	}
	catalog.rebuildCreditIndex()
	return nil
}
