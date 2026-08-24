package main

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

// wordSegmenter は日本語の文を単語（形態素）へ割る。
// ASRのtokenは日本語をほぼ1文字ずつへ割るため、そのままでは「昨|日」のような
// 単語の内部が切れ目になってしまう。鳴き声は単語の切れ目にだけ差し込む。
type wordSegmenter interface {
	SplitWords(string) []string
}

// wordBoundary は単語の切れ目。テキスト上のrune位置と、音声上の秒を持つ。
type wordBoundary struct {
	RuneIndex int
	AtSeconds float64
}

// 鳴き声を差し込まない位置を決めるための句読点。
// これらの直前で切ると、鳴き声のあとに読点の間が続いて不自然になる。
const boundarySkipBeforeRunes = "、。，．,.！？!?…"

type kagomeSegmenter struct {
	tokenizer *tokenizer.Tokenizer
}

// newKagomeSegmenter はIPA辞書の形態素解析器を作る。
// 辞書の読み込みは重いので起動時に1つ作って使い回す。解析器は並行に呼んでよい。
func newKagomeSegmenter() (*kagomeSegmenter, error) {
	instance, err := tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
	if err != nil {
		return nil, fmt.Errorf("load japanese dictionary: %w", err)
	}
	return &kagomeSegmenter{tokenizer: instance}, nil
}

func (segmenter *kagomeSegmenter) SplitWords(text string) []string {
	tokens := segmenter.tokenizer.Tokenize(text)
	words := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token.Surface == "" {
			continue
		}
		words = append(words, token.Surface)
	}
	return words
}

// insertionBoundaries は鳴き声を差し込める単語の切れ目を、前から順に返す。
// 文の先頭と末尾は候補にしない。先頭は「入れない」と決めた位置であり、
// 末尾は文中とは別枠で必ず入れるためである。
func insertionBoundaries(
	words []string,
	tokens []TranscriptToken,
	duration float64,
) []wordBoundary {
	if len(words) < 2 || len(tokens) == 0 {
		return nil
	}
	boundaries := make([]wordBoundary, 0, len(words)-1)
	runeIndex := 0
	previousSeconds := -1.0
	for index, word := range words[:len(words)-1] {
		runeIndex += utf8.RuneCountInString(word)
		if strings.ContainsRune(boundarySkipBeforeRunes, firstRune(words[index+1])) {
			continue
		}
		atSeconds, ok := boundarySeconds(tokens, runeIndex)
		if !ok || atSeconds <= 0 || atSeconds >= duration {
			continue
		}
		// 同じ時刻に重なる切れ目は1つだけ残す。ASRのtokenは時刻が潰れることがある。
		if atSeconds == previousSeconds {
			continue
		}
		previousSeconds = atSeconds
		boundaries = append(boundaries, wordBoundary{RuneIndex: runeIndex, AtSeconds: atSeconds})
	}
	return boundaries
}

// boundarySeconds はテキスト上のrune位置を音声上の秒へ直す。
// 切れ目がASRのtokenの内部へ落ちた場合（「いました」のような複数文字token）は、
// そのtokenの時間を文字数で按分する。
func boundarySeconds(tokens []TranscriptToken, runeIndex int) (float64, bool) {
	if runeIndex < 0 || len(tokens) == 0 {
		return 0, false
	}
	consumed := 0
	for _, token := range tokens {
		length := utf8.RuneCountInString(token.Text)
		if runeIndex == consumed {
			return token.StartSeconds, true
		}
		if runeIndex < consumed+length {
			ratio := float64(runeIndex-consumed) / float64(length)
			return token.StartSeconds + (token.EndSeconds-token.StartSeconds)*ratio, true
		}
		consumed += length
	}
	if runeIndex == consumed {
		return tokens[len(tokens)-1].EndSeconds, true
	}
	return 0, false
}

func firstRune(value string) rune {
	for _, character := range value {
		return character
	}
	return 0
}
