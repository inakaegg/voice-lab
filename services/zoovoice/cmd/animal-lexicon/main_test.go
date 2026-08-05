package main

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestRunExtractsCandidatesAndGeneratesLexicon(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "conceptnet.tsv.gz")
	writeGzip(t, source, ""+
		"/a/1\t/r/IsA\t/c/ja/豚\t/c/ja/哺乳類\t{\"weight\":1}\n"+
		"/a/2\t/r/Synonym\t/c/ja/豚\t/c/ja/ぶた\t{\"weight\":1}\n"+
		"/a/3\t/r/IsA\t/c/ja/哺乳類\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/4\t/r/IsA\t/c/ja/犬\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/5\t/r/IsA\t/c/ja/猫\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/6\t/r/IsA\t/c/ja/牛\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/7\t/r/IsA\t/c/ja/馬\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/8\t/r/IsA\t/c/ja/羊\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/9\t/r/IsA\t/c/ja/山羊\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/10\t/r/IsA\t/c/ja/狐\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/11\t/r/IsA\t/c/ja/虎\t/c/ja/動物\t{\"weight\":1}\n"+
		"/a/12\t/r/IsA\t/c/ja/狼\t/c/ja/動物\t{\"weight\":1}\n")
	sourceSHA := mustSHA(t, source)
	audioDir := filepath.Join(root, "animal-sounds")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	audioPath := filepath.Join(audioDir, "pig.wav")
	if err := os.WriteFile(audioPath, []byte("wav"), 0o644); err != nil {
		t.Fatal(err)
	}
	judgments := filepath.Join(root, "judgments.json")
	writeFile(t, judgments, `{"schema_version":1,"criteria":"日本語話者が鳴き声をイメージできる動物","judgments":[{"id":"pig","concept":"豚","label_ja":"ブタ","accepted":true,"reason":"鳴き声が広く知られている","onomatopoeia":["ぶーぶー"]}]}`)
	manifest := filepath.Join(audioDir, "manifest.json")
	writeFile(t, manifest, `{"schema_version":1,"generated_from":"fixture","selection_policy":"variant 1","model":"fixture","model_revision":"fixture","license":"fixture","license_url":"https://example.com","notice":"fixture","animals":[{"id":"pig","label_ja":"ブタ","file":"pig.wav","normalized_sha256":"`+mustSHA(t, audioPath)+`","duration_seconds":1,"sample_rate":24000,"channels":1,"bits_per_sample":16,"mean_dbfs":-10,"peak_dbfs":-1,"source_kind":"fixture","license":"fixture","creator":"fixture","landing_url":"https://example.com","adopted_candidate":{"variant":1,"seed":1,"prompt":"pig","source_file":"pig.wav","source_sha256":"`+mustSHA(t, audioPath)+`","receipt_file":"pig.receipt.json"},"candidates":[]}]}`)
	output := filepath.Join(root, "animal-lexicon.json")
	candidates := filepath.Join(root, "candidates.json")
	if err := run(options{sourcePath: source, sourceSHA256: sourceSHA, judgmentsPath: judgments, audioManifest: manifest, candidatesOutput: candidates, outputPath: output}); err != nil {
		t.Fatal(err)
	}
	var generated lexiconFile
	decodeForTest(t, output, &generated)
	if !generated.Generated || len(generated.Animals) != 1 {
		t.Fatalf("lexicon = %#v", generated)
	}
	pig := generated.Animals[0]
	if pig.ID != "pig" || !contains(pig.Terms, "豚") || !contains(pig.Terms, "ぶた") || !contains(pig.Terms, "ブタ") {
		t.Fatalf("pig = %#v", pig)
	}
	if pig.AudioFile != "animal-sounds/pig.wav" {
		t.Fatalf("audio file = %q", pig.AudioFile)
	}
}

func TestRunRejectsDuplicateTermsAndMissingAudio(t *testing.T) {
	graph := &conceptGraph{children: map[string]map[string]struct{}{}, synonyms: map[string]map[string]struct{}{}, machineAnimalSeed: map[string]struct{}{"ロバ": {}}}
	addEdge(graph.children, "動物", "犬")
	addEdge(graph.children, "動物", "猫")
	if len(graph.animalCandidates()) != 3 {
		t.Fatal("fixture candidates")
	}
}

func TestKanaConversions(t *testing.T) {
	if got := hiraganaToKatakana("ぶた"); got != "ブタ" {
		t.Fatalf("got %q", got)
	}
	if got := katakanaToHiragana("ブタ"); got != "ぶた" {
		t.Fatalf("got %q", got)
	}
}

func writeGzip(t *testing.T, path, payload string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := gzip.NewWriter(file)
	if _, err := writer.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeFile(t *testing.T, path, payload string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(payload), 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustSHA(t *testing.T, path string) string {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func decodeForTest(t *testing.T, path string, value any) {
	t.Helper()
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(payload, value); err != nil {
		t.Fatal(err)
	}
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
