package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestSoundCreditLineDropsEmptyParts(t *testing.T) {
	full := soundCredit{License: "CC0 1.0", Creator: "someone", SourceURL: "https://example.com/1"}
	if full.Line() != "CC0 1.0 / someone / https://example.com/1" {
		t.Fatalf("line = %q", full.Line())
	}
	licenseOnly := soundCredit{License: "CC0 1.0"}
	if licenseOnly.Line() != "CC0 1.0" {
		t.Fatalf("line = %q", licenseOnly.Line())
	}
}

func TestRepositoryCatalogHasCreditForEveryAnimal(t *testing.T) {
	catalog, err := loadCatalog("assets/animal-lexicon.json", "assets")
	if err != nil {
		t.Fatal(err)
	}
	if err := attachLegacyCredits(catalog, filepath.Join("assets", "animal-sounds", "manifest.json")); err != nil {
		t.Fatal(err)
	}
	for _, animal := range catalog.Animals {
		for _, variant := range animal.Variants {
			if variant.Credit.License == "" {
				t.Fatalf("animal %q has no license", animal.ID)
			}
		}
	}
}

func TestAttachLegacyCreditsRejectsMissingAnimal(t *testing.T) {
	catalog := testCatalog()
	manifestPath := filepath.Join(t.TempDir(), "manifest.json")
	manifest := `{"animals":[{"id":"cat","license":"CC0 1.0","creator":"a","landing_url":"https://example.com"}]}`
	if err := os.WriteFile(manifestPath, []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := attachLegacyCredits(catalog, manifestPath); err == nil {
		t.Fatal("missing credit accepted")
	}
}

func writeSoundsFixture(t *testing.T, breakSHA bool) (lexiconPath, soundsDir string) {
	t.Helper()
	root := t.TempDir()
	soundsDir = filepath.Join(root, "final")
	if err := os.MkdirAll(filepath.Join(soundsDir, "dog"), 0o755); err != nil {
		t.Fatal(err)
	}
	audio := []byte("dog audio")
	if err := os.WriteFile(filepath.Join(soundsDir, "dog", "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(audio)
	audioSHA := hex.EncodeToString(digest[:])
	if breakSHA {
		audioSHA = strings.Repeat("a", 64)
	}
	manifest := `{"schema_version":1,"animals":[
		{"id":"dog","label_ja":"犬","files":[
			{"file":"dog/dog-1.wav","license":"CC0 1.0","creator":"someone","source_url":"https://example.com/dog","sha256":` + strconv.Quote(audioSHA) + `}
		]},
		{"id":"black-kite","label_ja":"トビ","files":[
			{"file":"black-kite/black-kite-1.wav","license":"CC BY 4.0","creator":"else","source_url":"https://example.com/kite","sha256":"` + strings.Repeat("b", 64) + `"}
		]}
	]}`
	if err := os.WriteFile(filepath.Join(soundsDir, "manifest.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	lexicon := `{"schema_version":1,"generated":true,"do_not_edit":"generated","metadata":{},"animals":[
		{"id":"dog","label_ja":"犬","terms":["犬"],"onomatopoeia":[],"audio_file":"animal-sounds/dog.wav","audio_sha256":"` + strings.Repeat("c", 64) + `"}
	]}`
	lexiconPath = filepath.Join(root, "animal-lexicon.json")
	if err := os.WriteFile(lexiconPath, []byte(lexicon), 0o600); err != nil {
		t.Fatal(err)
	}
	return lexiconPath, soundsDir
}

func TestLoadSoundsCatalogAttachesCreditsAndReportsUnusedAnimals(t *testing.T) {
	lexiconPath, soundsDir := writeSoundsFixture(t, false)
	catalog, err := loadSoundsCatalog(lexiconPath, soundsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Animals) != 1 || catalog.Animals[0].ID != "dog" {
		t.Fatalf("animals = %#v", catalog.Animals)
	}
	variant := catalog.Animals[0].Variants[0]
	if variant.Credit.License != "CC0 1.0" || variant.Credit.Creator != "someone" {
		t.Fatalf("credit = %#v", variant.Credit)
	}
	// black-kite はレキシコンに無いので選択対象外の一覧に入り、音声実体は要求しない。
	if len(catalog.UnusedSoundAnimals) != 1 || catalog.UnusedSoundAnimals[0] != "black-kite" {
		t.Fatalf("unused = %#v", catalog.UnusedSoundAnimals)
	}
	credits := catalog.creditsForPaths([]string{variant.Path, variant.Path, "unknown.wav"})
	if len(credits) != 1 || credits[0] != variant.Credit {
		t.Fatalf("credits = %#v", credits)
	}
}

func TestLoadSoundsCatalogRejectsSHA256Mismatch(t *testing.T) {
	lexiconPath, soundsDir := writeSoundsFixture(t, true)
	if _, err := loadSoundsCatalog(lexiconPath, soundsDir); err == nil {
		t.Fatal("SHA-256 mismatch accepted")
	}
}

func TestPreviewTextPrintsSelectionAndCredits(t *testing.T) {
	catalog := testCatalog()
	dog := catalog.byID["dog"]
	dog.Variants[0].Credit = soundCredit{License: "CC0 1.0", Creator: "someone", SourceURL: "https://example.com/dog"}
	catalog.byID["dog"] = dog
	associator := fixedAssociator{selection: AnimalSelection{
		Species: "dog", LabelJA: "犬", EvidenceTerm: "犬", Strategy: strategyDirect,
	}}
	var output bytes.Buffer
	err := previewText(
		context.Background(),
		"犬が走る",
		catalog,
		associator,
		rand.New(rand.NewSource(1)),
		&output,
	)
	if err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, expected := range []string{"犬（dog）", "direct", "根拠語: 犬", "CC0 1.0 / someone / https://example.com/dog"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("output %q does not contain %q", text, expected)
		}
	}
}
