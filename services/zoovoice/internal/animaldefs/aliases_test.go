package animaldefs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadTrackedAnimalLexicon(t *testing.T) {
	catalog, err := Load(filepath.Join("..", "..", "assets", "animal-lexicon.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog) != 26 {
		t.Fatalf("animal count = %d, want 26", len(catalog))
	}
	pig := catalog["pig"]
	if pig.LabelJA != "ブタ" || pig.AudioFile != "animal-sounds/pig.wav" {
		t.Fatalf("pig = %#v", pig)
	}
	foundPork := false
	for _, term := range pig.Terms {
		if term == "豚肉" {
			foundPork = true
		}
	}
	if !foundPork {
		t.Fatalf("pig terms = %v, want 豚肉", pig.Terms)
	}
	if err := catalog.ValidateAvailable(catalog.IDs()); err != nil {
		t.Fatal(err)
	}
}

func TestLoadRejectsInvalidLexicon(t *testing.T) {
	valid := `{"schema_version":1,"generated":true,"do_not_edit":"generated","metadata":{},"animals":[{"id":"dog","label_ja":"犬","terms":["犬"],"onomatopoeia":[],"audio_file":"animal-sounds/dog.wav","audio_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`
	tests := []struct {
		name    string
		payload string
	}{
		{name: "not generated", payload: `{"schema_version":1,"generated":false,"do_not_edit":"generated","metadata":{},"animals":[]}`},
		{name: "empty terms", payload: `{"schema_version":1,"generated":true,"do_not_edit":"generated","metadata":{},"animals":[{"id":"dog","label_ja":"犬","terms":[],"onomatopoeia":[],"audio_file":"dog.wav","audio_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}`},
		{name: "unknown field", payload: valid[:len(valid)-1] + `,"extra":true}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "animal-lexicon.json")
			if err := os.WriteFile(path, []byte(test.payload), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := Load(path); err == nil {
				t.Fatal("Load accepted invalid lexicon")
			}
		})
	}
}

func TestValidateAvailableRejectsMissingAudioID(t *testing.T) {
	catalog, err := Load(filepath.Join("..", "..", "assets", "animal-lexicon.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := catalog.ValidateAvailable([]string{"dog"}); err == nil {
		t.Fatal("ValidateAvailable accepted missing animal audio")
	}
}
