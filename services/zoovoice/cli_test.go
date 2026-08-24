package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunPreviewCLIHelpSucceeds(t *testing.T) {
	var stdout, stderr strings.Builder
	exitCode := runPreviewCLI([]string{"-h"}, &stdout, &stderr)
	if exitCode != 0 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	for _, option := range []string{"-audio", "-intensity", "-species", "-text"} {
		if !strings.Contains(stderr.String(), option) {
			t.Errorf("help does not contain %s: %q", option, stderr.String())
		}
	}
}

func TestRunPreviewCLIValidatesIntensityForTextAndAudio(t *testing.T) {
	for _, input := range [][]string{{"-text", "確認"}, {"-audio", "missing.wav"}} {
		for _, intensity := range []string{"-1", "101"} {
			var stdout, stderr strings.Builder
			arguments := append(append([]string(nil), input...), "-intensity", intensity)
			exitCode := runPreviewCLI(arguments, &stdout, &stderr)
			if exitCode != 2 || !strings.Contains(stderr.String(), "0から100") {
				t.Fatalf("arguments %q: exit code = %d, stderr = %q", arguments, exitCode, stderr.String())
			}
		}
	}
}

func TestRunPreviewCLIAcceptsIntensityBounds(t *testing.T) {
	catalog := fixtureCatalog(t)
	soundsDir := filepath.Dir(filepath.Dir(catalog.Animals[0].Variants[0].Path))
	t.Setenv("ZOOVOICE_SOUNDS_DIR", soundsDir)
	t.Setenv("OPENAI_API_KEY", "")
	for _, intensity := range []string{"0", "100"} {
		var stdout, stderr strings.Builder
		exitCode := runPreviewCLI(
			[]string{"-text", "確認", "-species", "dog", "-intensity", intensity},
			&stdout,
			&stderr,
		)
		if exitCode != 0 {
			t.Fatalf("intensity %s: exit code = %d, stderr = %q", intensity, exitCode, stderr.String())
		}
	}
}

func TestParseFixedSpecies(t *testing.T) {
	for _, test := range []struct {
		name    string
		value   string
		want    []string
		wantErr string
	}{
		{name: "disabled", value: "", want: nil},
		{name: "one", value: "cat", want: []string{"cat"}},
		{name: "two", value: " cat, dog ", want: []string{"cat", "dog"}},
		{name: "empty item", value: "cat,", wantErr: "1件または2件"},
		{name: "duplicate", value: "cat,cat", wantErr: "重複"},
		{name: "too many", value: "cat,dog,rooster", wantErr: "1件または2件"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseFixedSpecies(test.value)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("parseFixedSpecies(%q) error = %v; want %q", test.value, err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(got, ",") != strings.Join(test.want, ",") {
				t.Fatalf("parseFixedSpecies(%q) = %q; want %q", test.value, got, test.want)
			}
		})
	}
}

func TestFixedAnimalAssociatorUsesCatalogLabelsWithoutAnAPIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	catalog := fixtureCatalog(t)
	associator, err := loadPreviewAssociator(catalog, []string{"cat", "dog"})
	if err != nil {
		t.Fatal(err)
	}
	selections, err := associator.Select(context.Background(), "昨日の夜", catalog.Animals, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections) != 2 {
		t.Fatalf("selections = %#v", selections)
	}
	if selections[0].Species != "cat" || selections[0].LabelJA != "猫" || selections[0].Strategy != strategyFixedCLI {
		t.Fatalf("first selection = %#v", selections[0])
	}
	if selections[1].Species != "dog" || selections[1].LabelJA != "犬" || selections[1].Strategy != strategyFixedCLI {
		t.Fatalf("second selection = %#v", selections[1])
	}
}

func TestLoadPreviewAssociatorRejectsUnknownFixedSpecies(t *testing.T) {
	_, err := loadPreviewAssociator(fixtureCatalog(t), []string{"unknown"})
	if err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("error = %v", err)
	}
}

func TestRunPreviewCLIRejectsAnimalsTogetherWithFixedSpecies(t *testing.T) {
	var stdout, stderr strings.Builder
	exitCode := runPreviewCLI(
		[]string{"-text", "犬", "-species", "dog", "-animals", "1"},
		&stdout,
		&stderr,
	)
	if exitCode != 2 {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
	if !strings.Contains(stderr.String(), "同時に指定") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestRunPreviewCLIRejectsExplicitEmptyAndUnknownFixedSpeciesAsUsageErrors(t *testing.T) {
	for _, value := range []string{"", "   "} {
		var stdout, stderr strings.Builder
		exitCode := runPreviewCLI(
			[]string{"-text", "犬", "-species", value},
			&stdout,
			&stderr,
		)
		if exitCode != 2 || !strings.Contains(stderr.String(), "1件または2件") {
			t.Fatalf("-species %q: exit code = %d, stderr = %q", value, exitCode, stderr.String())
		}
	}

	catalog := fixtureCatalog(t)
	soundsDir := filepath.Dir(filepath.Dir(catalog.Animals[0].Variants[0].Path))
	t.Setenv("ZOOVOICE_SOUNDS_DIR", soundsDir)
	t.Setenv("OPENAI_API_KEY", "")
	var stdout, stderr strings.Builder
	exitCode := runPreviewCLI(
		[]string{"-text", "犬", "-species", "unknown"},
		&stdout,
		&stderr,
	)
	if exitCode != 2 || !strings.Contains(stderr.String(), "音源カタログにありません") {
		t.Fatalf("exit code = %d, stderr = %q", exitCode, stderr.String())
	}
}
