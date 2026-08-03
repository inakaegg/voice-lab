package animaldefs

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

type Aliases struct {
	ID           string   `json:"id"`
	Terms        []string `json:"terms"`
	Onomatopoeia []string `json:"onomatopoeia"`
}

type Catalog map[string]Aliases

func Load(path string) (Catalog, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open association aliases: %w", err)
	}
	defer file.Close()

	var entries []Aliases
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&entries); err != nil {
		return nil, fmt.Errorf("decode association aliases: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return nil, fmt.Errorf("association aliases must contain one JSON value")
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("association aliases must not be empty")
	}

	catalog := make(Catalog, len(entries))
	seenAliases := make(map[string]string)
	for _, entry := range entries {
		entry.ID = strings.TrimSpace(entry.ID)
		if entry.ID == "" {
			return nil, fmt.Errorf("association alias id must not be empty")
		}
		if _, exists := catalog[entry.ID]; exists {
			return nil, fmt.Errorf("duplicate association alias id %q", entry.ID)
		}
		if len(entry.Terms) == 0 {
			return nil, fmt.Errorf("association alias %q must have terms", entry.ID)
		}
		for index := range entry.Terms {
			entry.Terms[index] = strings.TrimSpace(entry.Terms[index])
		}
		for index := range entry.Onomatopoeia {
			entry.Onomatopoeia[index] = strings.TrimSpace(entry.Onomatopoeia[index])
		}
		for _, alias := range append(append([]string{}, entry.Terms...), entry.Onomatopoeia...) {
			if alias == "" {
				return nil, fmt.Errorf("association alias %q contains an empty value", entry.ID)
			}
			if owner, exists := seenAliases[alias]; exists {
				return nil, fmt.Errorf("association alias %q is duplicated by %q and %q", alias, owner, entry.ID)
			}
			seenAliases[alias] = entry.ID
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
			return fmt.Errorf("association alias %q has no available animal", id)
		}
	}
	return nil
}
