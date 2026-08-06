package synonymindex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

const sampleLexicon = `<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource>
  <Lexicon id="wnja" language="ja" version="2.0">
    <LexicalEntry id="wnja-n-1">
      <Lemma writtenForm="喉" partOfSpeech="n" />
      <Form writtenForm="ノド" script="kana" />
      <Form writtenForm="のど" script="hira" />
      <Sense id="s1" synset="wnja-00001-n" />
    </LexicalEntry>
    <LexicalEntry id="wnja-n-2">
      <Lemma writtenForm="咽喉" partOfSpeech="n" />
      <Sense id="s2" synset="wnja-00001-n" />
    </LexicalEntry>
    <LexicalEntry id="wnja-n-3">
      <Lemma writtenForm="のど" partOfSpeech="n" />
      <Sense id="s3" synset="wnja-00001-n" />
    </LexicalEntry>
    <LexicalEntry id="wnja-v-4">
      <Lemma writtenForm="走る" partOfSpeech="v" />
      <Sense id="s4" synset="wnja-00002-v" />
    </LexicalEntry>
    <LexicalEntry id="wnja-v-5">
      <Lemma writtenForm="駆ける" partOfSpeech="v" />
      <Sense id="s5" synset="wnja-00002-v" />
    </LexicalEntry>
    <LexicalEntry id="wnja-n-6">
      <Lemma writtenForm="孤立語" partOfSpeech="n" />
      <Sense id="s6" synset="wnja-00003-n" />
    </LexicalEntry>
  </Lexicon>
</LexicalResource>
`

func buildSampleIndex(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	sourcePath := filepath.Join(root, "wnja.xml")
	if err := os.WriteFile(sourcePath, []byte(sampleLexicon), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceSHA, err := FileSHA256(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(root, "synonyms.sqlite")
	if err := Build(context.Background(), BuildOptions{
		SourcePath:   sourcePath,
		SourceSHA256: sourceSHA,
		OutputPath:   outputPath,
	}); err != nil {
		t.Fatal(err)
	}
	return outputPath, sourceSHA
}

func TestBuildLinksLemmasSharingASynset(t *testing.T) {
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	synonyms, err := store.Synonyms(context.Background(), []string{"喉"})
	if err != nil {
		t.Fatal(err)
	}

	got := make(map[string]string, len(synonyms))
	for _, synonym := range synonyms {
		got[synonym.Synonym] = synonym.Synset
	}
	if len(got) != 2 {
		t.Fatalf("synonyms = %v, want 2 entries", got)
	}
	for _, want := range []string{"咽喉", "のど"} {
		if got[want] != "wnja-00001-n" {
			t.Errorf("synonym %q synset = %q, want wnja-00001-n", want, got[want])
		}
	}
	if _, exists := got["ノド"]; exists {
		t.Fatalf("query-only Form must not be emitted as a synonym: %v", got)
	}
}

func TestBuildIndexesKanaFormsAsQueryableSpellings(t *testing.T) {
	// 入力の抽出語はかな表記のことがあるため、<Form>のかな表記でも引けなければならない。
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	for _, spelling := range []string{"のど", "ノド"} {
		synonyms, err := store.Synonyms(context.Background(), []string{spelling})
		if err != nil {
			t.Fatal(err)
		}
		found := make(map[string]bool, len(synonyms))
		for _, synonym := range synonyms {
			found[synonym.Synonym] = true
		}
		if !found["咽喉"] {
			t.Errorf("query %q: synonyms = %v, want to include 咽喉", spelling, found)
		}
		if found[spelling] {
			t.Errorf("query %q must not return itself: %v", spelling, found)
		}
	}
}

func TestBuildExcludesTheTermItself(t *testing.T) {
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	synonyms, err := store.Synonyms(context.Background(), []string{"走る"})
	if err != nil {
		t.Fatal(err)
	}

	for _, synonym := range synonyms {
		if synonym.Synonym == "走る" {
			t.Fatalf("synonyms must not contain the query term itself: %+v", synonyms)
		}
	}
	if len(synonyms) != 1 || synonyms[0].Synonym != "駆ける" {
		t.Fatalf("synonyms = %+v, want only 駆ける", synonyms)
	}
}

func TestBuildSkipsSynsetsWithASingleLemma(t *testing.T) {
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	synonyms, err := store.Synonyms(context.Background(), []string{"孤立語"})
	if err != nil {
		t.Fatal(err)
	}

	if len(synonyms) != 0 {
		t.Fatalf("synonyms = %+v, want none", synonyms)
	}
}

func TestOpenRejectsASourceMismatch(t *testing.T) {
	outputPath, _ := buildSampleIndex(t)

	if _, err := Open(outputPath, "0000000000000000000000000000000000000000000000000000000000000000"); err == nil {
		t.Fatal("expected an error when the source hash does not match")
	}
}

func TestSynonymsDeduplicatesAndIgnoresBlankQueries(t *testing.T) {
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	synonyms, err := store.Synonyms(context.Background(), []string{"走る", " 走る ", "", "存在しない語"})
	if err != nil {
		t.Fatal(err)
	}

	if len(synonyms) != 1 {
		t.Fatalf("synonyms = %+v, want 1 entry", synonyms)
	}
}

func TestSynonymsReturnsEmptyForNoQueries(t *testing.T) {
	outputPath, sourceSHA := buildSampleIndex(t)
	store, err := Open(outputPath, sourceSHA)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	synonyms, err := store.Synonyms(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(synonyms) != 0 {
		t.Fatalf("synonyms = %+v, want none", synonyms)
	}
}
