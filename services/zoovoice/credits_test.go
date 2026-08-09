package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
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

func TestCatalogHasCreditForEveryAnimal(t *testing.T) {
	catalog := fixtureCatalog(t)
	for _, animal := range catalog.Animals {
		for _, variant := range animal.Variants {
			if variant.Credit.License == "" {
				t.Fatalf("animal %q has no license", animal.ID)
			}
		}
	}
}

func TestLoadSoundsCatalogRejectsEntryWithoutLicense(t *testing.T) {
	root := t.TempDir()
	animalDir := filepath.Join(root, "dog")
	if err := os.MkdirAll(animalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audio := []byte("dog")
	if err := os.WriteFile(filepath.Join(animalDir, "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(audio)
	manifest := `{"schema_version":1,"animals":[{"id":"dog","label_ja":"犬","files":[{"file":"dog/dog-1.wav","sha256":` +
		strconv.Quote(hex.EncodeToString(digest[:])) + `,"creator":"someone"}]}]}`
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadSoundsCatalog(root); err == nil {
		t.Fatal("entry without license accepted")
	}
}

// writeSoundsFixture は最終セット（tmp1/final）と同じスキーマの音源ディレクトリを作る。
func writeSoundsFixture(t *testing.T, breakSHA bool) (soundsDir string) {
	t.Helper()
	soundsDir = filepath.Join(t.TempDir(), "final")
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
		]}
	]}`
	if err := os.WriteFile(filepath.Join(soundsDir, "manifest.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	return soundsDir
}

func TestLoadSoundsCatalogAttachesCredits(t *testing.T) {
	catalog, err := loadSoundsCatalog(writeSoundsFixture(t, false))
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
	credits := catalog.creditsForPaths([]string{variant.Path, variant.Path, "unknown.wav"})
	if len(credits) != 1 || credits[0] != variant.Credit {
		t.Fatalf("credits = %#v", credits)
	}
}

func TestLoadSoundsCatalogRejectsSHA256Mismatch(t *testing.T) {
	if _, err := loadSoundsCatalog(writeSoundsFixture(t, true)); err == nil {
		t.Fatal("SHA-256 mismatch accepted")
	}
}

func TestPreviewTextPrintsSelectionReasonAndCredits(t *testing.T) {
	catalog := testCatalog()
	dog := catalog.byID["dog"]
	dog.Variants[0].Credit = soundCredit{License: "CC0 1.0", Creator: "someone", SourceURL: "https://example.com/dog"}
	catalog.byID["dog"] = dog
	associator := fixedAssociator{selection: AnimalSelection{
		Species: "dog", LabelJA: "犬", Reason: "散歩といえば犬", Strategy: strategyLLM,
	}}
	var output bytes.Buffer
	if err := previewText(context.Background(), "犬の散歩に行った", catalog, associator, &output); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, expected := range []string{"犬（dog）", "連想の理由: 散歩といえば犬", "CC0 1.0 / someone / https://example.com/dog"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("output %q does not contain %q", text, expected)
		}
	}
}
