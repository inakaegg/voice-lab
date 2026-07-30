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

type IntensityConfig struct {
	MinSilenceSeconds float64
	MaxInsertions     int
}

type Arrangement struct {
	Opening *string `json:"opening"`
	Gaps    *string `json:"gaps"`
	Ending  *string `json:"ending"`
}

type ComposeSettings struct {
	Arrangement Arrangement `json:"arrangement"`
	Intensity   int         `json:"intensity"`
}

type ResolvedInsertion struct {
	Slot      string  `json:"slot"`
	Species   string  `json:"species"`
	AtSeconds float64 `json:"at_seconds"`
	AssetPath string  `json:"-"`
}

type AnimalSummary struct {
	ID       string `json:"id"`
	LabelJA  string `json:"label_ja"`
	Variants int    `json:"variants"`
}
