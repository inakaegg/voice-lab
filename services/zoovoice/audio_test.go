package main

import (
	"errors"
	"testing"
)

func TestParseSilenceDetectClosesTrailingSilenceAtAudioEnd(t *testing.T) {
	stderr := `
[silencedetect @ 0x1] silence_start: 0
[silencedetect @ 0x1] silence_end: 1.25 | silence_duration: 1.25
[silencedetect @ 0x1] silence_start: 2.5
`

	got := parseSilenceDetect(stderr, 4)
	want := []SilenceInterval{
		{Start: 0, End: 1.25},
		{Start: 2.5, End: 4},
	}

	if len(got) != len(want) {
		t.Fatalf("interval count = %d, want %d: %#v", len(got), len(want), got)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Errorf("interval %d = %#v, want %#v", index, got[index], want[index])
		}
	}
}

func TestBuildFilterGraphDelaysEachAnimalAndKeepsOriginalVolume(t *testing.T) {
	insertions := []ResolvedInsertion{
		{AtSeconds: 0},
		{AtSeconds: 1.2345},
	}

	got := buildFilterGraph(insertions)
	want := "[0:a]asetpts=PTS-STARTPTS[base];" +
		"[1:a]afade=t=in:st=0:d=0.01,areverse,afade=t=in:st=0:d=0.01,areverse,adelay=0[s1];" +
		"[2:a]afade=t=in:st=0:d=0.01,areverse,afade=t=in:st=0:d=0.01,areverse,adelay=1235[s2];" +
		"[base][s1][s2]amix=inputs=3:normalize=0:duration=longest[out]"

	if got != want {
		t.Fatalf("filter graph:\n got: %s\nwant: %s", got, want)
	}
}

func TestMapIntensityUsesSpecifiedEndpointsAndMidpoint(t *testing.T) {
	tests := []struct {
		intensity     int
		minSilence    float64
		maxInsertions int
	}{
		{intensity: 0, minSilence: 1.2, maxInsertions: 2},
		{intensity: 50, minSilence: 0.75, maxInsertions: 6},
		{intensity: 100, minSilence: 0.3, maxInsertions: 10},
	}

	for _, test := range tests {
		got, err := mapIntensity(test.intensity)
		if err != nil {
			t.Fatalf("mapIntensity(%d): %v", test.intensity, err)
		}
		if got.MinSilenceSeconds != test.minSilence || got.MaxInsertions != test.maxInsertions {
			t.Errorf("mapIntensity(%d) = %#v, want d=%v max=%d", test.intensity, got, test.minSilence, test.maxInsertions)
		}
	}

	for _, intensity := range []int{-1, 101} {
		if _, err := mapIntensity(intensity); err == nil {
			t.Errorf("mapIntensity(%d) accepted an out-of-range value", intensity)
		}
	}
}

func TestValidateAudioLimitsRejectsSizeDurationAndSpeechShortage(t *testing.T) {
	tests := []struct {
		name       string
		size       int64
		duration   float64
		speech     float64
		statusCode int
		errorCode  string
	}{
		{name: "size", size: maxAudioBytes + 1, duration: 5, speech: 2, statusCode: 413, errorCode: "audio_too_large"},
		{name: "duration", size: 100, duration: 60.001, speech: 2, statusCode: 413, errorCode: "audio_too_long"},
		{name: "speech", size: 100, duration: 5, speech: 0.499, statusCode: 422, errorCode: "speech_too_short"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateAudioLimits(test.size, test.duration, test.speech)
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatalf("error = %v, want *APIError", err)
			}
			if apiErr.Status != test.statusCode || apiErr.Code != test.errorCode {
				t.Fatalf("error = %#v, want status=%d code=%s", apiErr, test.statusCode, test.errorCode)
			}
		})
	}

	if err := validateAudioLimits(maxAudioBytes, 60, 0.5); err != nil {
		t.Fatalf("boundary values rejected: %v", err)
	}
}
