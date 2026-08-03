package animaldefs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

func TestLoadMatchesTrackedCC0Animals(t *testing.T) {
	aliases, err := Load(filepath.Join("..", "..", "assets", "association-aliases.json"))
	if err != nil {
		t.Fatal(err)
	}

	manifestPayload, err := os.ReadFile(filepath.Join("..", "..", "assets", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest []struct {
		Animal string `json:"animal"`
	}
	if err := json.Unmarshal(manifestPayload, &manifest); err != nil {
		t.Fatal(err)
	}
	wantIDs := make([]string, 0, len(manifest))
	for _, entry := range manifest {
		wantIDs = append(wantIDs, entry.Animal)
	}
	sort.Strings(wantIDs)

	gotIDs := aliases.IDs()
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("alias IDs = %v, want tracked CC0 IDs %v", gotIDs, wantIDs)
	}
	if err := aliases.ValidateAvailable(wantIDs); err != nil {
		t.Fatalf("ValidateAvailable: %v", err)
	}
}

func TestLoadRejectsInvalidAliases(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{name: "empty id", payload: `[{"id":"","terms":["犬"],"onomatopoeia":[]}]`},
		{name: "empty terms", payload: `[{"id":"dog","terms":[],"onomatopoeia":[]}]`},
		{name: "empty alias", payload: `[{"id":"dog","terms":[""],"onomatopoeia":[]}]`},
		{name: "duplicate normalized alias", payload: `[{"id":"dog","terms":["犬"," 犬 "],"onomatopoeia":[]}]`},
		{name: "duplicate id", payload: `[{"id":"dog","terms":["犬"],"onomatopoeia":[]},{"id":"dog","terms":["いぬ"],"onomatopoeia":[]}]`},
		{name: "unknown field", payload: `[{"id":"dog","terms":["犬"],"onomatopoeia":[],"extra":true}]`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "aliases.json")
			if err := os.WriteFile(path, []byte(test.payload), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("Load accepted invalid aliases")
			}
		})
	}
}

func TestValidateAvailableRejectsUnknownAliasID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "aliases.json")
	if err := os.WriteFile(path, []byte(`[{"id":"unicorn","terms":["一角獣"],"onomatopoeia":[]}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	aliases, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := aliases.ValidateAvailable([]string{"dog"}); err == nil {
		t.Fatal("ValidateAvailable accepted an alias without an available animal")
	}
}
