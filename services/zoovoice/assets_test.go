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

func TestRepositoryAnimalLexiconHasOneValidAudioPerAnimal(t *testing.T) {
	catalog, err := loadCatalog("assets/animal-lexicon.json", "assets")
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Animals) != 27 {
		t.Fatalf("animal count = %d, want 27", len(catalog.Animals))
	}
	for _, animal := range catalog.Animals {
		if len(animal.Variants) != 1 {
			t.Fatalf("%s variants = %d, want 1", animal.ID, len(animal.Variants))
		}
	}
}

func TestRepositoryAnimalAudioIsDecodableAndNormalized(t *testing.T) {
	ffprobe, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is unavailable")
	}
	catalog, err := loadCatalog("assets/animal-lexicon.json", "assets")
	if err != nil {
		t.Fatal(err)
	}
	for _, animal := range catalog.Animals {
		output, err := exec.Command(ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels:format=duration", "-of", "json", animal.Variants[0].Path).Output()
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
		if err != nil || duration < 0.15 || duration > 5.01 || probe.Streams[0].CodecName != "pcm_s16le" || probe.Streams[0].SampleRate != "24000" || probe.Streams[0].Channels != 1 {
			t.Fatalf("unexpected normalized audio for %s: %s", animal.ID, output)
		}
	}
}

func TestLoadCatalogRejectsMissingAndMismatchedAudio(t *testing.T) {
	root := t.TempDir()
	audioDir := filepath.Join(root, "animal-sounds")
	if err := os.Mkdir(audioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audioPath := filepath.Join(audioDir, "dog.wav")
	if err := os.WriteFile(audioPath, []byte("dog"), 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("dog"))
	payload := func(file, digest string) string {
		return `{"schema_version":1,"generated":true,"do_not_edit":"generated","metadata":{},"animals":[{"id":"dog","label_ja":"犬","terms":["犬"],"onomatopoeia":[],"audio_file":` + strconv.Quote(file) + `,"audio_sha256":` + strconv.Quote(digest) + `}]}`
	}
	lexiconPath := filepath.Join(root, "animal-lexicon.json")
	for _, test := range []struct{ name, file, digest string }{
		{"missing", "animal-sounds/missing.wav", hex.EncodeToString(hash[:])},
		{"mismatch", "animal-sounds/dog.wav", strings.Repeat("a", 64)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(lexiconPath, []byte(payload(test.file, test.digest)), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := loadCatalog(lexiconPath, root); err == nil {
				t.Fatal("loadCatalog accepted invalid audio")
			}
		})
	}
}
