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

func TestMapIntensityRoundsToFiveStages(t *testing.T) {
	tests := []struct {
		intensity     int
		minSilence    float64
		maxInsertions int
	}{
		{intensity: 0, minSilence: 1.2, maxInsertions: 2},
		{intensity: 19, minSilence: 1.2, maxInsertions: 2},
		{intensity: 20, minSilence: 0.975, maxInsertions: 3},
		{intensity: 40, minSilence: 0.75, maxInsertions: 6},
		{intensity: 50, minSilence: 0.75, maxInsertions: 6},
		{intensity: 59, minSilence: 0.75, maxInsertions: 6},
		{intensity: 60, minSilence: 0.525, maxInsertions: 8},
		{intensity: 80, minSilence: 0.3, maxInsertions: 10},
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

func TestParseLoudnessSummaryReadsTheEbur128Summary(t *testing.T) {
	stderr := `[Parsed_ebur128_0 @ 0x1] t: 1.2 M: -14.2 S: -14.4 I: -14.1 LUFS  LRA: 1.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.5 LUFS

  True peak:
    Peak:       -0.4 dBFS
`
	measurement := parseLoudnessSummary(stderr)
	if !measurement.Measurable || measurement.IntegratedLUFS != -14.3 || measurement.TruePeakDBTP != -0.4 {
		t.Fatalf("parseLoudnessSummary = %#v", measurement)
	}
}

func TestParseLoudnessSummaryTreatsSilenceAsUnmeasurable(t *testing.T) {
	stderr := `  Integrated loudness:
    I:         -inf LUFS

  True peak:
    Peak:       -inf dBFS
`
	if measurement := parseLoudnessSummary(stderr); measurement.Measurable {
		t.Fatalf("silence must not be measurable: %#v", measurement)
	}
}

func TestLoudnessGainOnlyAttenuates(t *testing.T) {
	tests := []struct {
		name        string
		measurement loudnessMeasurement
		gain        float64
	}{
		{
			name:        "louder than the target is pulled down",
			measurement: loudnessMeasurement{IntegratedLUFS: -14.3, TruePeakDBTP: -3.0, Measurable: true},
			gain:        -4.7,
		},
		{
			name:        "true peak headroom wins over the loudness target",
			measurement: loudnessMeasurement{IntegratedLUFS: -20.0, TruePeakDBTP: -0.2, Measurable: true},
			gain:        -1.3,
		},
		{
			name:        "quieter than the target is left alone",
			measurement: loudnessMeasurement{IntegratedLUFS: -26.0, TruePeakDBTP: -8.0, Measurable: true},
			gain:        0,
		},
		{
			name:        "a difference below 0.1dB is left alone",
			measurement: loudnessMeasurement{IntegratedLUFS: -18.95, TruePeakDBTP: -8.0, Measurable: true},
			gain:        0,
		},
		{
			name:        "an unmeasurable input is left alone",
			measurement: loudnessMeasurement{},
			gain:        0,
		},
	}

	for _, test := range tests {
		if got := loudnessGainDB(test.measurement); got != test.gain {
			t.Errorf("%s: loudnessGainDB = %v, want %v", test.name, got, test.gain)
		}
	}
}
