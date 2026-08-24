package main

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestKagomeSegmenterKeepsEveryCharacterAndGroupsWords(t *testing.T) {
	segmenter := newTestSegmenter(t)
	for _, text := range []string{
		whisperFixtureTranscript,
		"犬が公園を走っています",
		"こんにちは",
	} {
		words := segmenter.SplitWords(text)
		if joined := strings.Join(words, ""); joined != text {
			t.Fatalf("SplitWords(%q) joined = %q", text, joined)
		}
	}
	// 「昨日」が1語にまとまらないと、「昨」と「日」の間が挿入候補になってしまう。
	words := segmenter.SplitWords(whisperFixtureTranscript)
	if words[0] != "昨日" {
		t.Fatalf("words = %q", words)
	}
}

// ASRのtoken時刻と形態素解析を繋いだ、実測fixtureでの通し確認。
func TestInsertionBoundariesLandOnWordBreaksOfRealTranscript(t *testing.T) {
	segmenter := newTestSegmenter(t)
	transcription := parseWhisperTranscript(whisperMaxLenFixture)
	words := segmenter.SplitWords(transcription.Text)
	const duration = 3.840
	boundaries := insertionBoundaries(words, transcription.Tokens, duration)
	if len(boundaries) == 0 {
		t.Fatalf("no boundaries for words %q", words)
	}

	wordBreaks := map[int]bool{}
	offset := 0
	for _, word := range words[:len(words)-1] {
		offset += utf8.RuneCountInString(word)
		wordBreaks[offset] = true
	}
	previous := 0.0
	for _, boundary := range boundaries {
		if !wordBreaks[boundary.RuneIndex] {
			t.Fatalf("boundary %+v is not a word break in %q", boundary, words)
		}
		if boundary.AtSeconds <= 0 || boundary.AtSeconds >= duration {
			t.Fatalf("boundary %+v is outside the audio", boundary)
		}
		if boundary.AtSeconds < previous {
			t.Fatalf("boundaries are not sorted: %+v after %v", boundary, previous)
		}
		previous = boundary.AtSeconds
	}
	// 「昨日」の内側（rune位置1）と、読点の直前（「夜」と「、」の間＝rune位置4）は候補にしない。
	for _, boundary := range boundaries {
		if boundary.RuneIndex == 1 || boundary.RuneIndex == 4 {
			t.Fatalf("unexpected boundary %+v in %q", boundary, words)
		}
	}
}

// 一形態素だけの入力でも失敗せず、文中の候補が0件になる（末尾挿入は別枠で入る）。
func TestInsertionBoundariesReturnsNoneForSingleWord(t *testing.T) {
	segmenter := newTestSegmenter(t)
	words := segmenter.SplitWords("こんにちは")
	tokens := []TranscriptToken{{Text: "こんにちは", StartSeconds: 0.1, EndSeconds: 1.0}}
	if boundaries := insertionBoundaries(words, tokens, 1.2); len(boundaries) != 0 {
		t.Fatalf("boundaries = %+v for words %q", boundaries, words)
	}
	if boundaries := insertionBoundaries(nil, tokens, 1.2); len(boundaries) != 0 {
		t.Fatalf("boundaries = %+v for no words", boundaries)
	}
}

func TestInsertionBoundariesSkipsPunctuationAndOutOfRangeTimes(t *testing.T) {
	tokens := []TranscriptToken{
		{Text: "犬", StartSeconds: 0.0, EndSeconds: 0.4},
		{Text: "が", StartSeconds: 0.4, EndSeconds: 0.8},
		{Text: "、", StartSeconds: 0.8, EndSeconds: 1.0},
		{Text: "鳴く", StartSeconds: 1.0, EndSeconds: 1.8},
	}
	words := []string{"犬", "が", "、", "鳴く"}
	boundaries := insertionBoundaries(words, tokens, 1.8)
	// 「犬|が」は0.4秒、「が|、」は読点の直前なので除外、「、|鳴く」は1.0秒。
	if len(boundaries) != 2 || boundaries[0].AtSeconds != 0.4 || boundaries[1].AtSeconds != 1.0 {
		t.Fatalf("boundaries = %+v", boundaries)
	}
	// 音声より短い長さを渡すと、範囲外の切れ目は落ちる。
	if boundaries := insertionBoundaries(words, tokens, 0.5); len(boundaries) != 1 {
		t.Fatalf("boundaries = %+v", boundaries)
	}
}

func TestBoundarySecondsInterpolatesInsideMultiRuneTokens(t *testing.T) {
	tokens := []TranscriptToken{
		{Text: "い", StartSeconds: 0.0, EndSeconds: 1.0},
		{Text: "いました", StartSeconds: 1.0, EndSeconds: 3.0},
	}
	for _, test := range []struct {
		runeIndex int
		want      float64
		ok        bool
	}{
		{runeIndex: 0, want: 0.0, ok: true},
		{runeIndex: 1, want: 1.0, ok: true},
		{runeIndex: 2, want: 1.5, ok: true},
		{runeIndex: 3, want: 2.0, ok: true},
		{runeIndex: 5, want: 3.0, ok: true},
		{runeIndex: 6, ok: false},
		{runeIndex: -1, ok: false},
	} {
		seconds, ok := boundarySeconds(tokens, test.runeIndex)
		if ok != test.ok || (ok && seconds != test.want) {
			t.Errorf("boundarySeconds(%d) = %v, %v; want %v, %v", test.runeIndex, seconds, ok, test.want, test.ok)
		}
	}
	if _, ok := boundarySeconds(nil, 0); ok {
		t.Error("boundarySeconds accepted an empty transcript")
	}
}

func newTestSegmenter(t *testing.T) *kagomeSegmenter {
	t.Helper()
	segmenter, err := newKagomeSegmenter()
	if err != nil {
		t.Fatal(err)
	}
	return segmenter
}
