package main

import (
	"errors"
	"fmt"
	"strings"
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

// 差し込み（concat）で組むため、出力は発話＋鳴き声の長さになる。重ね合わせではない。
func TestBuildFilterGraphSplicesAnimalsBetweenSpeechChunks(t *testing.T) {
	insertions := []ResolvedInsertion{
		{Slot: slotWord, AtSeconds: 1.0, DurationSeconds: 0.8},
		{Slot: slotEnding, AtSeconds: 4.0, DurationSeconds: 2.5},
	}

	got := buildFilterGraph(insertions, 4.0)
	const format = "aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=mono"
	const edgeFade = ",afade=t=in:st=0:d=0.010,afade=t=out:st=%s:d=0.010"
	want := "[0:a]asplit=2[p0][p1];" +
		"[p0]atrim=start=0.000:end=1.000,asetpts=N/SR/TB" +
		fmt.Sprintf(edgeFade, "0.990") + "," + format + "[b0];" +
		"[p1]atrim=start=1.000:end=4.000,asetpts=N/SR/TB" +
		fmt.Sprintf(edgeFade, "2.990") + "," + format + "[b1];" +
		"[1:a]atrim=end=0.800,asetpts=N/SR/TB,afade=t=in:st=0:d=0.010," +
		"areverse,afade=t=in:st=0:d=0.010,areverse," + format + "[s1];" +
		"[2:a]atrim=end=2.500,asetpts=N/SR/TB,afade=t=in:st=0:d=0.010," +
		"areverse,afade=t=in:st=0:d=0.010,areverse," + format + "[s2];" +
		"[b0][s1][b1][s2]concat=n=4:v=0:a=1[out]"

	if got != want {
		t.Fatalf("filter graph:\n got: %s\nwant: %s", got, want)
	}
}

// 末尾より手前で音声が終わる区間が残る場合は、最後に発話の残りを繋ぐ。
func TestBuildFilterGraphKeepsTrailingSpeechAfterTheLastInsertion(t *testing.T) {
	got := buildFilterGraph([]ResolvedInsertion{
		{Slot: slotWord, AtSeconds: 1.0, DurationSeconds: 0.8},
	}, 3.0)
	if !strings.HasSuffix(got, "[b0][s1][b1]concat=n=3:v=0:a=1[out]") {
		t.Fatalf("filter graph = %s", got)
	}
	if !strings.Contains(got, "atrim=start=1.000:end=3.000") {
		t.Fatalf("filter graph = %s", got)
	}
}

// 挿入が1つで発話がその位置で終わる場合は、分岐せずに1区間だけを切る。
func TestBuildFilterGraphSkipsSplitForASingleSpeechChunk(t *testing.T) {
	got := buildFilterGraph([]ResolvedInsertion{
		{Slot: slotEnding, AtSeconds: 2.0, DurationSeconds: 2.5},
	}, 2.0)
	if strings.Contains(got, "asplit") {
		t.Fatalf("filter graph = %s", got)
	}
	if !strings.HasPrefix(got, "[0:a]atrim=start=0.000:end=2.000,asetpts=N/SR/TB,afade=t=in") {
		t.Fatalf("filter graph = %s", got)
	}
}

// 短すぎる区間にはfadeを掛けない。fade 2つぶんの長さが取れないため。
func TestSpliceEdgeFadeSkipsVeryShortChunks(t *testing.T) {
	if fade := spliceEdgeFade(0.02); fade != "" {
		t.Fatalf("fade = %q", fade)
	}
	if fade := spliceEdgeFade(1.0); fade != ",afade=t=in:st=0:d=0.010,afade=t=out:st=0.990:d=0.010" {
		t.Fatalf("fade = %q", fade)
	}
}

func TestTargetWordInsertionCountScalesWithDurationAndIntensity(t *testing.T) {
	tests := []struct {
		duration  float64
		intensity int
		want      int
	}{
		{duration: 3.908, intensity: 0, want: 0},
		{duration: 3.908, intensity: 50, want: 1},
		{duration: 3.908, intensity: 100, want: 2},
		{duration: 20, intensity: 50, want: 5},
		{duration: 60, intensity: 50, want: 15},
		// 候補決定に使わなかった長さでも、同じ密度で比例する。
		{duration: 1, intensity: 50, want: 0},
		{duration: 1, intensity: 100, want: 1},
		{duration: 5, intensity: 50, want: 1},
		{duration: 5, intensity: 100, want: 3},
		{duration: 15, intensity: 50, want: 4},
		{duration: 15, intensity: 100, want: 8},
		{duration: 45, intensity: 50, want: 11},
		{duration: 45, intensity: 100, want: 23},
	}

	for _, test := range tests {
		if got := targetWordInsertionCount(test.duration, test.intensity); got != test.want {
			t.Errorf("targetWordInsertionCount(%v, %d) = %d, want %d", test.duration, test.intensity, got, test.want)
		}
	}
	if got := targetWordInsertionCount(0, 100); got != 0 {
		t.Errorf("targetWordInsertionCount(0, 100) = %d, want 0", got)
	}
}

func TestValidateIntensityRejectsOutOfRange(t *testing.T) {
	for _, intensity := range []int{-1, 101} {
		if err := validateIntensity(intensity); err == nil {
			t.Errorf("validateIntensity(%d) accepted an out-of-range value", intensity)
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
