package animaldefs

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

type Animal struct {
	ID           string   `json:"id"`
	LabelJA      string   `json:"label_ja"`
	Terms        []string `json:"terms"`
	Onomatopoeia []string `json:"onomatopoeia"`
	AudioFile    string   `json:"audio_file"`
	AudioSHA256  string   `json:"audio_sha256"`
}

type Catalog map[string]Animal

type lexiconFile struct {
	SchemaVersion int             `json:"schema_version"`
	Generated     bool            `json:"generated"`
	DoNotEdit     string          `json:"do_not_edit"`
	Metadata      json.RawMessage `json:"metadata"`
	Animals       []Animal        `json:"animals"`
}

func Load(path string) (Catalog, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open animal lexicon: %w", err)
	}
	defer file.Close()
	var payload lexiconFile
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode animal lexicon: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("animal lexicon must contain one JSON value")
	}
	if payload.SchemaVersion != 1 || !payload.Generated || strings.TrimSpace(payload.DoNotEdit) == "" || len(payload.Metadata) == 0 {
		return nil, fmt.Errorf("animal lexicon generation metadata is invalid")
	}
	if len(payload.Animals) == 0 {
		return nil, fmt.Errorf("animal lexicon must not be empty")
	}
	catalog := make(Catalog, len(payload.Animals))
	seenTerms := make(map[string]string)
	for _, entry := range payload.Animals {
		entry.ID = strings.TrimSpace(entry.ID)
		entry.LabelJA = strings.TrimSpace(entry.LabelJA)
		entry.AudioFile = strings.TrimSpace(entry.AudioFile)
		entry.AudioSHA256 = strings.ToLower(strings.TrimSpace(entry.AudioSHA256))
		if entry.ID == "" || entry.LabelJA == "" || entry.AudioFile == "" || len(entry.AudioSHA256) != 64 {
			return nil, fmt.Errorf("animal lexicon entry %q is incomplete", entry.ID)
		}
		if _, exists := catalog[entry.ID]; exists {
			return nil, fmt.Errorf("duplicate animal lexicon id %q", entry.ID)
		}
		if len(entry.Terms) == 0 {
			return nil, fmt.Errorf("animal lexicon entry %q must have terms", entry.ID)
		}
		for index := range entry.Terms {
			entry.Terms[index] = strings.TrimSpace(entry.Terms[index])
		}
		for index := range entry.Onomatopoeia {
			entry.Onomatopoeia[index] = strings.TrimSpace(entry.Onomatopoeia[index])
		}
		for _, term := range append(append([]string{}, entry.Terms...), entry.Onomatopoeia...) {
			if term == "" {
				return nil, fmt.Errorf("animal lexicon entry %q contains an empty term", entry.ID)
			}
			if owner, exists := seenTerms[term]; exists {
				return nil, fmt.Errorf("animal lexicon term %q is duplicated by %q and %q", term, owner, entry.ID)
			}
			seenTerms[term] = entry.ID
		}
		catalog[entry.ID] = entry
	}
	return catalog, nil
}

func (catalog Catalog) IDs() []string {
	ids := make([]string, 0, len(catalog))
	for id := range catalog {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func (catalog Catalog) ValidateAvailable(availableIDs []string) error {
	available := make(map[string]struct{}, len(availableIDs))
	for _, id := range availableIDs {
		available[id] = struct{}{}
	}
	for id := range catalog {
		if _, ok := available[id]; !ok {
			return fmt.Errorf("animal lexicon entry %q has no available audio", id)
		}
	}
	return nil
}
