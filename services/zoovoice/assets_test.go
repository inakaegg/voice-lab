package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

// gatewayの検査を通らないIDや表示名を起動時に通すと、公開requestが502で落ちる。
func TestLoadSoundsCatalogRejectsIdentifiersTheGatewayWouldReject(t *testing.T) {
	root := t.TempDir()
	audio := []byte("dog")
	if err := os.MkdirAll(filepath.Join(root, "dog"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dog", "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(audio)
	manifestPath := filepath.Join(root, "manifest.json")
	payload := func(id, label string) string {
		return `{"schema_version":1,"animals":[{"id":` + strconv.Quote(id) + `,"label_ja":` + strconv.Quote(label) +
			`,"files":[{"file":"dog/dog-1.wav","license":"CC0 1.0","sha256":` +
			strconv.Quote(hex.EncodeToString(hash[:])) + `}]}]}`
	}
	for _, test := range []struct {
		name, id, label string
		accepted        bool
	}{
		{name: "lowercase id", id: "dog_2-a", label: "犬", accepted: true},
		{name: "label at the limit", id: "dog", label: strings.Repeat("犬", 80), accepted: true},
		{name: "empty id", id: "", label: "犬"},
		{name: "uppercase id", id: "Dog", label: "犬"},
		{name: "japanese id", id: "犬", label: "犬"},
		{name: "id over the limit", id: strings.Repeat("d", 81), label: "犬"},
		{name: "blank label", id: "dog", label: "   "},
		{name: "label over the limit", id: "dog", label: strings.Repeat("犬", 81)},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := os.WriteFile(manifestPath, []byte(payload(test.id, test.label)), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := loadSoundsCatalog(root)
			if test.accepted && err != nil {
				t.Fatalf("loadSoundsCatalog rejected a valid entry: %v", err)
			}
			if !test.accepted && err == nil {
				t.Fatal("loadSoundsCatalog accepted an entry the gateway would reject")
			}
		})
	}
}

// 表示義務のあるライセンスで作者と配布ページが欠けた素材は、出典を出せないまま配信されてしまう。
func TestLoadSoundsCatalogRequiresAttributionWhenTheLicenseNeedsCredit(t *testing.T) {
	root := t.TempDir()
	animalDir := filepath.Join(root, "dog")
	if err := os.MkdirAll(animalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audio := []byte("dog")
	if err := os.WriteFile(filepath.Join(animalDir, "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := hex.EncodeToString(func() []byte { sum := sha256.Sum256(audio); return sum[:] }())
	manifestPath := filepath.Join(root, "manifest.json")
	payload := func(license, creator, sourceURL string) string {
		return `{"schema_version":1,"animals":[{"id":"dog","label_ja":"犬","files":[{"file":"dog/dog-1.wav","license":` +
			strconv.Quote(license) + `,"creator":` + strconv.Quote(creator) + `,"source_url":` +
			strconv.Quote(sourceURL) + `,"sha256":` + strconv.Quote(hash) + `}]}]}`
	}
	for _, test := range []struct {
		name                        string
		license, creator, sourceURL string
		accepted                    bool
	}{
		{name: "cc by without creator", license: "CC BY 4.0", sourceURL: "https://example.com/dog"},
		{name: "cc by without source url", license: "CC BY 4.0", creator: "someone"},
		{name: "taira komori without creator", license: "Taira Komori 利用規約", sourceURL: "https://example.com/dog"},
		{name: "cc by with attribution", license: "CC BY 4.0", creator: "someone", sourceURL: "https://example.com/dog", accepted: true},
		{name: "cc0 without attribution", license: "CC0 1.0", accepted: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			content := payload(test.license, test.creator, test.sourceURL)
			if err := os.WriteFile(manifestPath, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := loadSoundsCatalog(root)
			if test.accepted && err != nil {
				t.Fatalf("loadSoundsCatalog rejected a valid entry: %v", err)
			}
			if !test.accepted && err == nil {
				t.Fatal("loadSoundsCatalog accepted an entry without the required credit")
			}
		})
	}
}

// gatewayはクレジットの文字数とURLの形も検査する。条件外のクレジットを載せた素材が
// 選ばれると、その回の合成結果だけがWorkerに捨てられる。起動時に落とす。
func TestLoadSoundsCatalogRejectsCreditsTheGatewayWouldReject(t *testing.T) {
	root := t.TempDir()
	animalDir := filepath.Join(root, "dog")
	if err := os.MkdirAll(animalDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audio := []byte("dog")
	if err := os.WriteFile(filepath.Join(animalDir, "dog-1.wav"), audio, 0o600); err != nil {
		t.Fatal(err)
	}
	hash := hex.EncodeToString(func() []byte { sum := sha256.Sum256(audio); return sum[:] }())
	manifestPath := filepath.Join(root, "manifest.json")
	payload := func(license, creator, sourceURL string) string {
		return `{"schema_version":1,"animals":[{"id":"dog","label_ja":"犬","files":[{"file":"dog/dog-1.wav","license":` +
			strconv.Quote(license) + `,"creator":` + strconv.Quote(creator) + `,"source_url":` +
			strconv.Quote(sourceURL) + `,"sha256":` + strconv.Quote(hash) + `}]}]}`
	}
	longURL := "https://example.com/" + strings.Repeat("d", 500-len("https://example.com/"))
	for _, test := range []struct {
		name                        string
		license, creator, sourceURL string
		accepted                    bool
	}{
		{name: "credit at the limits", license: "CC BY 4.0", creator: strings.Repeat("c", 200), sourceURL: longURL, accepted: true},
		{name: "blank license", license: "   "},
		{name: "license over the limit", license: strings.Repeat("l", 201)},
		{name: "blank creator", license: "CC BY 4.0", creator: "   ", sourceURL: "https://example.com/dog"},
		{name: "creator over the limit", license: "CC BY 4.0", creator: strings.Repeat("c", 201), sourceURL: "https://example.com/dog"},
		{name: "http source url", license: "CC BY 4.0", creator: "someone", sourceURL: "http://example.com/dog"},
		{name: "source url without a scheme", license: "CC BY 4.0", creator: "someone", sourceURL: "example.com/dog"},
		{name: "source url over the limit", license: "CC BY 4.0", creator: "someone", sourceURL: longURL + "d"},
		{name: "http source url on a cc0 file", license: "CC0 1.0", sourceURL: "http://example.com/dog"},
	} {
		t.Run(test.name, func(t *testing.T) {
			content := payload(test.license, test.creator, test.sourceURL)
			if err := os.WriteFile(manifestPath, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := loadSoundsCatalog(root)
			if test.accepted && err != nil {
				t.Fatalf("loadSoundsCatalog rejected a valid entry: %v", err)
			}
			if !test.accepted && err == nil {
				t.Fatal("loadSoundsCatalog accepted a credit the gateway would reject")
			}
		})
	}
}

// カタログ側の上限はgatewayのWorkerと同じ値でなければ意味がない。
// 片方だけ変えると検査をすり抜けるので、Workerのソースに書かれた数値と突き合わせる。
func TestCatalogLimitsMatchTheGatewayContract(t *testing.T) {
	source, err := os.ReadFile(filepath.Join("..", "..", "cloudflare", "zoovoice-gateway.mjs"))
	if err != nil {
		t.Fatal(err)
	}
	gateway := string(source)
	if !strings.Contains(gateway, `/^[a-z0-9_-]+$/`) {
		t.Fatal("the gateway no longer restricts identifiers to /^[a-z0-9_-]+$/")
	}
	for _, test := range []struct {
		name, pattern string
		want          int
	}{
		{name: "animal id", pattern: `isBoundedIdentifier\(animal\.id, (\d+)\)`, want: catalogIDMaxUnits},
		{name: "animal label", pattern: `isBoundedString\(animal\.label_ja, 1, (\d+)\)`, want: catalogLabelMaxUnits},
		{name: "credit license", pattern: `isBoundedString\(credit\.license, 1, (\d+)\)`, want: catalogCreditTextMaxUnits},
		{name: "credit creator", pattern: `isBoundedString\(credit\.creator, 1, (\d+)\)`, want: catalogCreditTextMaxUnits},
		{name: "source url", pattern: `isBoundedHttpsUrl\(value\) \{\n  if \(!isBoundedString\(value, 1, (\d+)\)\)`, want: catalogSourceURLMaxUnits},
	} {
		t.Run(test.name, func(t *testing.T) {
			match := regexp.MustCompile(test.pattern).FindStringSubmatch(gateway)
			if match == nil {
				t.Fatalf("the gateway no longer contains a limit matching %s", test.pattern)
			}
			limit, err := strconv.Atoi(match[1])
			if err != nil {
				t.Fatal(err)
			}
			if limit != test.want {
				t.Fatalf("gateway limit = %d, catalog limit = %d", limit, test.want)
			}
		})
	}
}
