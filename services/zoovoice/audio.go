package main

import (
	"bufio"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var (
	silenceStartPattern = regexp.MustCompile(`silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)`)
	silenceEndPattern   = regexp.MustCompile(`silence_end:\s*(-?[0-9]+(?:\.[0-9]+)?)`)
	// ebur128 の Summary 行だけに当たるよう、行頭のラベルで拾う。
	integratedLoudnessPattern = regexp.MustCompile(`(?m)^\s*I:\s*(-?(?:inf|[0-9]+(?:\.[0-9]+)?))\s*LUFS`)
	truePeakPattern           = regexp.MustCompile(`(?m)^\s*Peak:\s*(-?(?:inf|[0-9]+(?:\.[0-9]+)?))\s*dBFS`)
)

// 合成後の音量の目安。上限であり、これより大きくはしない。
const (
	targetLoudnessLUFS  = -19.0
	truePeakCeilingDBTP = -1.5
	// この幅より小さい調整は掛け直しの手間に見合わないので省く。
	minimumGainAdjustmentDB = 0.1
)

// loudnessMeasurement は ebur128 の測定結果。
// 無音などで測れなかった場合は Measurable が false になる。
type loudnessMeasurement struct {
	IntegratedLUFS float64
	TruePeakDBTP   float64
	Measurable     bool
}

// parseLoudnessSummary は ffmpeg の ebur128 が出す要約から
// integrated loudness と true peak を取り出す。
func parseLoudnessSummary(stderr string) loudnessMeasurement {
	loudness, loudnessOK := lastFloatMatch(integratedLoudnessPattern, stderr)
	peak, peakOK := lastFloatMatch(truePeakPattern, stderr)
	if !loudnessOK || !peakOK {
		return loudnessMeasurement{}
	}
	return loudnessMeasurement{IntegratedLUFS: loudness, TruePeakDBTP: peak, Measurable: true}
}

func lastFloatMatch(pattern *regexp.Regexp, text string) (float64, bool) {
	matches := pattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return 0, false
	}
	raw := matches[len(matches)-1][1]
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsInf(value, 0) {
		return 0, false
	}
	return value, true
}

// loudnessGainDB は完成音声へ掛ける静的gainを決める。
// 目標より静かな音声は持ち上げず、true peak が天井を超えるときはさらに下げる。
func loudnessGainDB(measurement loudnessMeasurement) float64 {
	if !measurement.Measurable {
		return 0
	}
	gain := math.Min(0, targetLoudnessLUFS-measurement.IntegratedLUFS)
	gain = math.Min(gain, truePeakCeilingDBTP-measurement.TruePeakDBTP)
	if gain > -minimumGainAdjustmentDB {
		return 0
	}
	return math.Round(gain*10) / 10
}

func parseSilenceDetect(stderr string, totalDuration float64) []SilenceInterval {
	intervals := make([]SilenceInterval, 0)
	var openStart *float64
	scanner := bufio.NewScanner(strings.NewReader(stderr))
	for scanner.Scan() {
		line := scanner.Text()
		if match := silenceStartPattern.FindStringSubmatch(line); match != nil {
			value, err := strconv.ParseFloat(match[1], 64)
			if err == nil {
				value = clampSeconds(value, totalDuration)
				openStart = &value
			}
			continue
		}
		if match := silenceEndPattern.FindStringSubmatch(line); match != nil && openStart != nil {
			value, err := strconv.ParseFloat(match[1], 64)
			if err != nil {
				continue
			}
			end := clampSeconds(value, totalDuration)
			if end > *openStart {
				intervals = append(intervals, SilenceInterval{Start: *openStart, End: end})
			}
			openStart = nil
		}
	}
	if openStart != nil && totalDuration > *openStart {
		intervals = append(intervals, SilenceInterval{Start: *openStart, End: totalDuration})
	}
	return intervals
}

func clampSeconds(value, duration float64) float64 {
	if value < 0 {
		return 0
	}
	if value > duration {
		return duration
	}
	return value
}

func buildFilterGraph(insertions []ResolvedInsertion) string {
	var graph strings.Builder
	graph.WriteString("[0:a]asetpts=PTS-STARTPTS[base];")
	for index, insertion := range insertions {
		inputIndex := index + 1
		delayMilliseconds := int64(math.Round(math.Max(0, insertion.AtSeconds) * 1000))
		fmt.Fprintf(
			&graph,
			"[%d:a]afade=t=in:st=0:d=0.01,areverse,afade=t=in:st=0:d=0.01,areverse,adelay=%d[s%d];",
			inputIndex,
			delayMilliseconds,
			inputIndex,
		)
	}
	graph.WriteString("[base]")
	for index := range insertions {
		fmt.Fprintf(&graph, "[s%d]", index+1)
	}
	fmt.Fprintf(
		&graph,
		"amix=inputs=%d:normalize=0:duration=longest[out]",
		len(insertions)+1,
	)
	return graph.String()
}

// アニマル度は0〜100の入力を20刻みで5段階へ丸めてから使う。
// APIの入力形式は0〜100のまま変えない。
const intensityStageCount = 5

// 段階ごとの最大挿入数と無音検出の下限秒数。
// 端（段階1・5）と中央（段階3）は従来の一次式と同じ値になる。
var (
	intensityMaxInsertions = [intensityStageCount]int{2, 3, 6, 8, 10}
	intensityMinSilence    = [intensityStageCount]float64{1.2, 0.975, 0.75, 0.525, 0.3}
)

// intensityStage は0〜100のアニマル度を0始まりの段階番号へ丸める。
func intensityStage(intensity int) int {
	stage := intensity / 20
	if stage >= intensityStageCount {
		stage = intensityStageCount - 1
	}
	return stage
}

func mapIntensity(intensity int) (IntensityConfig, error) {
	if intensity < 0 || intensity > 100 {
		return IntensityConfig{}, fmt.Errorf("intensity must be between 0 and 100")
	}
	stage := intensityStage(intensity)
	return IntensityConfig{
		MinSilenceSeconds: intensityMinSilence[stage],
		MaxInsertions:     intensityMaxInsertions[stage],
	}, nil
}

func validateAudioLimits(size int64, duration, speechDuration float64) error {
	switch {
	case size > maxAudioBytes:
		return &APIError{
			Status:  413,
			Code:    "audio_too_large",
			Message: "音声ファイルは10MB以下にしてください。",
		}
	case duration > maxAudioSeconds:
		return &APIError{
			Status:  413,
			Code:    "audio_too_long",
			Message: "録音は60秒以下にしてください。",
		}
	case speechDuration < minSpeechSeconds:
		return &APIError{
			Status:  422,
			Code:    "speech_too_short",
			Message: "0.5秒以上話した音声を送ってください。",
		}
	default:
		return nil
	}
}
