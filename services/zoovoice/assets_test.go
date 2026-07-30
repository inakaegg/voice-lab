package main

import (
	"bytes"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadCatalogKeepsOnlyExistingFilesAndWarnsWhenExtraAssetsAreMissing(t *testing.T) {
	root := t.TempDir()
	cc0Dir := filepath.Join(root, "cc0")
	if err := os.Mkdir(cc0Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cc0Dir, "cat.wav"), []byte("cat"), 0o644); err != nil {
		t.Fatal(err)
	}
	masterPath := filepath.Join(root, "animals.json")
	master := `[
  {"id":"cat","label_ja":"猫","sources":[
    {"dir":"cc0","file":"cat.wav"},
    {"dir":"extra","file":"cat2.wav"}
  ]},
  {"id":"owl","label_ja":"フクロウ","sources":[
    {"dir":"extra","file":"owl.wav"}
  ]}
]`
	if err := os.WriteFile(masterPath, []byte(master), 0o644); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer

	catalog, err := loadCatalog(masterPath, cc0Dir, "", log.New(&logs, "", 0))
	if err != nil {
		t.Fatal(err)
	}

	summaries := catalog.publicAnimals()
	if len(summaries) != 1 {
		t.Fatalf("animals = %#v, want only cat", summaries)
	}
	if summaries[0].ID != "cat" || summaries[0].LabelJA != "猫" || summaries[0].Variants != 1 {
		t.Fatalf("cat summary = %#v", summaries[0])
	}
	if !bytes.Contains(logs.Bytes(), []byte("extra assets")) {
		t.Fatalf("missing-extra warning not logged: %q", logs.String())
	}
}

func TestLoadCatalogAddsExistingExtraVariants(t *testing.T) {
	root := t.TempDir()
	cc0Dir := filepath.Join(root, "cc0")
	extraDir := filepath.Join(root, "extra")
	for _, directory := range []string{cc0Dir, extraDir} {
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for path, body := range map[string]string{
		filepath.Join(cc0Dir, "cat.wav"):    "cat",
		filepath.Join(extraDir, "cat2.wav"): "cat2",
		filepath.Join(extraDir, "owl.wav"):  "owl",
	} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	masterPath := filepath.Join(root, "animals.json")
	master := `[
  {"id":"cat","label_ja":"猫","sources":[
    {"dir":"cc0","file":"cat.wav"},
    {"dir":"extra","file":"cat2.wav"}
  ]},
  {"id":"owl","label_ja":"フクロウ","sources":[
    {"dir":"extra","file":"owl.wav"}
  ]}
]`
	if err := os.WriteFile(masterPath, []byte(master), 0o644); err != nil {
		t.Fatal(err)
	}

	catalog, err := loadCatalog(masterPath, cc0Dir, extraDir, log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}

	summaries := catalog.publicAnimals()
	if len(summaries) != 2 {
		t.Fatalf("animals = %#v, want cat and owl", summaries)
	}
	if summaries[0].ID != "cat" || summaries[0].Variants != 2 {
		t.Fatalf("cat summary = %#v", summaries[0])
	}
	if summaries[1].ID != "owl" || summaries[1].Variants != 1 {
		t.Fatalf("owl summary = %#v", summaries[1])
	}
}

func TestRepositoryAnimalMasterPreservesAssetLicenseBoundary(t *testing.T) {
	const masterPath = "assets/animals.json"
	payload, err := os.ReadFile(masterPath)
	if err != nil {
		t.Fatal(err)
	}
	var definitions []animalDefinition
	if err := json.Unmarshal(payload, &definitions); err != nil {
		t.Fatal(err)
	}

	extraDir := t.TempDir()
	excluded := map[string]bool{
		"flapping_wings.wav": true,
		"give_me_food.wav":   true,
		"play_with_me.wav":   true,
		"take_me1.wav":       true,
		"take_me2.wav":       true,
	}
	extraCount := 0
	for _, definition := range definitions {
		for _, source := range definition.Sources {
			if excluded[source.File] {
				t.Fatalf("excluded third-party asset is referenced: %s", source.File)
			}
			if source.Dir != "extra" {
				continue
			}
			extraCount++
			if err := os.WriteFile(filepath.Join(extraDir, source.File), []byte("fixture"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if extraCount != 75 {
		t.Fatalf("extra source count = %d, want 75 approved files", extraCount)
	}

	cc0Only, err := loadCatalog(masterPath, "assets/cc0", "", log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	if got := cc0Only.publicAnimals(); len(got) != 12 {
		t.Fatalf("CC0-only animal count = %d, want 12: %#v", len(got), got)
	}

	full, err := loadCatalog(masterPath, "assets/cc0", extraDir, log.New(os.Stderr, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	summaries := full.publicAnimals()
	if len(summaries) != 29 {
		t.Fatalf("full animal count = %d, want 29: %#v", len(summaries), summaries)
	}
	variantCount := 0
	for _, summary := range summaries {
		variantCount += summary.Variants
	}
	if variantCount != 87 {
		t.Fatalf("variant count = %d, want 12 CC0 + 75 approved extra", variantCount)
	}
}
