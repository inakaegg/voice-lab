package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// 鳴き声素材はリポジトリに置かない（第三者素材の再配布を避けるため）。
// テストは実素材の代わりに、この場で作る決定的な合成音でカタログを組み立てる。
var fixtureAnimals = []struct {
	id      string
	labelJA string
	hertz   float64
}{
	{"cat", "猫", 660},
	{"dog", "犬", 440},
	{"rooster", "鶏", 880},
}

// fixtureCatalog は最終セット（ZOOVOICE_SOUNDS_DIR）と同じ構成の音源ディレクトリを
// 一時領域へ作り、実行時と同じ読み込み経路でカタログを返す。
func fixtureCatalog(t *testing.T) *assetCatalog {
	t.Helper()
	soundsDir := filepath.Join(t.TempDir(), "final")
	type manifestFile struct {
		File      string `json:"file"`
		License   string `json:"license"`
		Creator   string `json:"creator"`
		SourceURL string `json:"source_url"`
		SHA256    string `json:"sha256"`
	}
	type manifestAnimal struct {
		ID      string         `json:"id"`
		LabelJA string         `json:"label_ja"`
		Files   []manifestFile `json:"files"`
	}
	manifest := struct {
		SchemaVersion int              `json:"schema_version"`
		Animals       []manifestAnimal `json:"animals"`
	}{SchemaVersion: 1}

	for _, animal := range fixtureAnimals {
		relative := filepath.Join(animal.id, animal.id+"-1.wav")
		path := filepath.Join(soundsDir, relative)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		audio := sineWAV(animal.hertz, 0.6)
		if err := os.WriteFile(path, audio, 0o600); err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(audio)
		manifest.Animals = append(manifest.Animals, manifestAnimal{
			ID: animal.id, LabelJA: animal.labelJA,
			Files: []manifestFile{{
				File:      filepath.ToSlash(relative),
				License:   "CC0 1.0",
				Creator:   "zoovoice test fixture",
				SourceURL: "https://example.com/" + animal.id,
				SHA256:    hex.EncodeToString(digest[:]),
			}},
		})
	}
	payload, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(soundsDir, "manifest.json"), payload, 0o600); err != nil {
		t.Fatal(err)
	}
	catalog, err := loadSoundsCatalog(soundsDir)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

// sineWAV は 24 kHz / mono / signed 16-bit PCM の WAV バイト列を作る。
// 実行時素材と同じ形式なので、ffmpeg を通す合成テストでもそのまま使える。
func sineWAV(hertz, seconds float64) []byte {
	const sampleRate = 24000
	sampleCount := int(seconds * sampleRate)
	dataSize := sampleCount * 2

	buffer := make([]byte, 0, 44+dataSize)
	buffer = append(buffer, "RIFF"...)
	buffer = binary.LittleEndian.AppendUint32(buffer, uint32(36+dataSize))
	buffer = append(buffer, "WAVEfmt "...)
	buffer = binary.LittleEndian.AppendUint32(buffer, 16)
	buffer = binary.LittleEndian.AppendUint16(buffer, 1)
	buffer = binary.LittleEndian.AppendUint16(buffer, 1)
	buffer = binary.LittleEndian.AppendUint32(buffer, sampleRate)
	buffer = binary.LittleEndian.AppendUint32(buffer, sampleRate*2)
	buffer = binary.LittleEndian.AppendUint16(buffer, 2)
	buffer = binary.LittleEndian.AppendUint16(buffer, 16)
	buffer = append(buffer, "data"...)
	buffer = binary.LittleEndian.AppendUint32(buffer, uint32(dataSize))
	for index := 0; index < sampleCount; index++ {
		value := math.Sin(2 * math.Pi * hertz * float64(index) / sampleRate)
		buffer = binary.LittleEndian.AppendUint16(buffer, uint16(int16(value*0.5*math.MaxInt16)))
	}
	return buffer
}
