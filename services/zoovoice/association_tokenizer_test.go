package main

import (
	"slices"
	"testing"
)

var representativeAssociationInputs = []struct {
	name    string
	input   string
	include []string
	exclude []string
}{
	{
		name:    "onomatopoeia and auxiliary verb",
		input:   "にゃーにゃー鳴いてるやつがいる",
		include: []string{"にゃーにゃー", "鳴く"},
		exclude: []string{"ー", "てる", "やつ"},
	},
	{
		name:    "kanji and hiragana reading",
		input:   "喉が渇いた",
		include: []string{"喉", "のど", "渇く"},
		exclude: []string{"が", "た"},
	},
	{
		name:    "adjacent compound nouns",
		input:   "北海道大学で学ぶ",
		include: []string{"北海道", "大学", "北海道大学", "学ぶ"},
		exclude: []string{"で"},
	},
	{
		name:    "particles between content words",
		input:   "牧場でミルクをしぼった",
		include: []string{"牧場", "ぼくじょう", "ミルク", "しぼる"},
		exclude: []string{"牧場ミルク", "で", "を", "た"},
	},
	{
		name:    "particle prevents noun compound",
		input:   "山と羊がいる",
		include: []string{"山", "羊"},
		exclude: []string{"山羊", "と"},
	},
	{
		name:    "noun reading",
		input:   "猫が好き",
		include: []string{"猫", "ねこ"},
		exclude: []string{"が", "好き"},
	},
	{
		name:    "adjective base form",
		input:   "今日はとても暑かった",
		include: []string{"暑い"},
		exclude: []string{"今日", "は", "とても", "た"},
	},
	{
		name:    "verb base form",
		input:   "会議を始めました",
		include: []string{"会議", "かいぎ", "始める"},
		exclude: []string{"を", "まし", "た"},
	},
	{
		name:    "filler",
		input:   "えーと犬を見た",
		include: []string{"犬", "いぬ", "見る"},
		exclude: []string{"えーと", "を", "た"},
	},
	{
		name:    "pronoun and auxiliary",
		input:   "これは速い車です",
		include: []string{"速い", "車", "くるま"},
		exclude: []string{"これ", "は", "です"},
	},
}

func TestAssociationTokenizerRepresentativeInputs(t *testing.T) {
	for _, test := range representativeAssociationInputs {
		t.Run(test.name, func(t *testing.T) {
			terms := associationTermTexts(tokenizeAssociationTerms(test.input))
			t.Logf("input=%q terms=%q", test.input, terms)
			for _, expected := range test.include {
				if !slices.Contains(terms, expected) {
					t.Errorf("required term %q missing from %q", expected, terms)
				}
			}
			for _, excluded := range test.exclude {
				if slices.Contains(terms, excluded) {
					t.Errorf("excluded term %q appears in %q", excluded, terms)
				}
			}
		})
	}
}

func TestAssociationTokenizerOnlyBuildsOneAdjacentNounCompound(t *testing.T) {
	terms := associationTermTexts(tokenizeAssociationTerms("北海道大学研究室"))
	for _, expected := range []string{"北海道大学", "大学研究", "研究室"} {
		if !slices.Contains(terms, expected) {
			t.Errorf("adjacent two-noun compound %q missing from %q", expected, terms)
		}
	}
	for _, excluded := range []string{"室", "北海道大学研究", "大学研究室", "北海道大学研究室"} {
		if slices.Contains(terms, excluded) {
			t.Errorf("excluded suffix or compound longer than one join %q appears in %q", excluded, terms)
		}
	}
}

func TestAssociationTokenizerKeepsNonSymbolUnknownWord(t *testing.T) {
	terms := associationTermTexts(tokenizeAssociationTerms("Zoovoiceでモフモフした"))
	if !slices.Contains(terms, "Zoovoice") {
		t.Fatalf("unknown word Zoovoice missing from %q", terms)
	}
	if slices.Contains(terms, "ー") {
		t.Fatalf("standalone prolonged sound mark appears in %q", terms)
	}
}

func BenchmarkTokenizeAssociationTerms(b *testing.B) {
	for i := 0; i < b.N; i++ {
		for _, test := range representativeAssociationInputs {
			_ = tokenizeAssociationTerms(test.input)
		}
	}
}

func associationTermTexts(terms []associationTerm) []string {
	texts := make([]string, 0, len(terms))
	for _, term := range terms {
		texts = append(texts, term.Text)
	}
	return texts
}
