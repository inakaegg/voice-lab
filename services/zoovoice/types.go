package main

import "fmt"

const (
	maxAudioBytes         int64 = 10_000_000
	maxAudioSeconds             = 60.0
	minSpeechSeconds            = 0.5
	silenceNoiseThreshold       = "-35dB"
)

type APIError struct {
	Status  int
	Code    string
	Message string
	Err     error
}

func (e *APIError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Err)
	}
	return e.Message
}

func (e *APIError) Unwrap() error {
	return e.Err
}

type SilenceInterval struct {
	Start float64
	End   float64
}

type ComposeSettings struct {
	Intensity int `json:"intensity"`
	// AnimalCount は連想する動物の種類数。1が既定で、2にすると2種を交互へ割り当てる。
	AnimalCount int `json:"animal_count"`
}

// 動物の種類数の既定と上限。利用者が画面のトグルで選ぶ。
const (
	defaultAnimalCount = 1
	maxAnimalCount     = 2
)

func validateAnimalCount(count int) error {
	if count < 1 || count > maxAnimalCount {
		return fmt.Errorf("animal count must be 1 or %d", maxAnimalCount)
	}
	return nil
}

// 挿入位置の種別。先頭へは挿入しないため opening は無い。
const (
	slotWord   = "word"
	slotEnding = "ending"
)

type ResolvedInsertion struct {
	Slot string `json:"slot"`
	// Species は鳴き声の動物ID。2種のときは挿入ごとに入れ替わる。
	Species   string  `json:"species"`
	AtSeconds float64 `json:"at_seconds"`
	// DurationSeconds は実際に差し込む長さ。素材はこの長さで切り詰める。
	DurationSeconds float64 `json:"duration_seconds"`
	AssetPath       string  `json:"-"`
}

type AnimalSummary struct {
	ID       string `json:"id"`
	LabelJA  string `json:"label_ja"`
	Variants int    `json:"variants"`
}

type SelectedAnimal struct {
	ID      string `json:"id"`
	LabelJA string `json:"label_ja"`
}

// AnimalChoice は連想した動物1件。meta.selected_animals の各要素になる。
// 1件だけの既定でも配列で返し、利用側が件数で分岐しなくて済むようにする。
type AnimalChoice struct {
	ID      string `json:"id"`
	LabelJA string `json:"label_ja"`
	Reason  string `json:"reason"`
}
