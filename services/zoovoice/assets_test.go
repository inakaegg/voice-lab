package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestRuntimeCatalogRequiresSoundsDirectory(t *testing.T) {
	t.Setenv("ZOOVOICE_SOUNDS_DIR", "")
	if _, err := loadRuntimeCatalog(); err == nil {
		t.Fatal("catalog loaded without ZOOVOICE_SOUNDS_DIR")
	}
}

func TestFixtureCatalogHasOneVariantPerAnimal(t *testing.T) {
	catalog := fixtureCatalog(t)
	if len(catalog.Animals) != len(fixtureAnimals) {
		t.Fatalf("animal count = %d, want %d", len(catalog.Animals), len(fixtureAnimals))
	}
	for _, animal := range catalog.Animals {
		if len(animal.Variants) != 1 {
			t.Fatalf("%s variants = %d, want 1", animal.ID, len(animal.Variants))
		}
	}
}

// 実素材はリポジトリに無いため、ZOOVOICE_SOUNDS_DIR を指定したときだけ実素材を検査する。
func TestConfiguredSoundsAreDecodableAndNormalized(t *testing.T) {
	soundsDir := os.Getenv("ZOOVOICE_SOUNDS_DIR")
	if soundsDir == "" {
		t.Skip("ZOOVOICE_SOUNDS_DIR is unset")
	}
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is unavailable")
	}
	catalog, err := loadSoundsCatalog(soundsDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, animal := range catalog.Animals {
		for _, variant := range animal.Variants {
			output, err := exec.Command(ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", variant.Path).Output()
			if err != nil {
				t.Fatalf("ffprobe %s: %v", animal.ID, err)
			}
			var probe struct {
				Streams []struct {
					CodecName  string `json:"codec_name"`
					SampleRate string `json:"sample_rate"`
					Channels   int    `json:"channels"`
				} `json:"streams"`
				Format struct {
					Duration string `json:"duration"`
				} `json:"format"`
			}
			if err := json.Unmarshal(output, &probe); err != nil || len(probe.Streams) != 1 {
				t.Fatalf("decode probe %s: %v (%s)", animal.ID, err, output)
			}
			duration, err := strconv.ParseFloat(probe.Format.Duration, 64)
			if err != nil || duration < 0.15 || duration > 8.01 || probe.Streams[0].CodecName != "pcm_s16le" || probe.Streams[0].SampleRate != "24000" || probe.Streams[0].Channels != 1 {
				t.Fatalf("unexpected normalized audio for %s: %s", animal.ID, output)
			}
		}
	}
}

func TestLoadSoundsCatalogRejectsMissingAndMismatchedAudio(t *testing.T) {
	root := t.TempDir()
	animalDir := filepath.Join(root, "dog")
	if err := os.MkdirAll(animalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audio := []byte("dog")
	if err := os.WriteFile(filepath.Join(animalDir, "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(audio)
	manifestPath := filepath.Join(root, "manifest.json")
	payload := func(file, digest string) string {
		return `{"schema_version":1,"animals":[{"id":"dog","label_ja":"犬","files":[{"file":` + strconv.Quote(file) +
			`,"license":"CC0 1.0","creator":"someone","source_url":"https://example.com/dog","sha256":` +
			strconv.Quote(digest) + `}]}]}`
	}
	for _, test := range []struct{ name, file, digest string }{
		{"missing", "dog/missing.wav", hex.EncodeToString(hash[:])},
		{"mismatch", "dog/dog-1.wav", strings.Repeat("a", 64)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(manifestPath, []byte(payload(test.file, test.digest)), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadSoundsCatalog(root); err == nil {
				t.Fatal("loadSoundsCatalog accepted invalid audio")
			}
		})
	}
}
