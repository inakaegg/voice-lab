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

// 鳴き声の前後に掛けるfade。切り貼りの継ぎ目のノイズを消すためだけの短いもの。
const (
	insertionFadeInSeconds  = 0.01
	insertionFadeOutSeconds = 0.01
)

// 合成後の音声形式。concatは全ての入力が同じ形式であることを要求する。
const spliceSampleFormat = "aformat=sample_fmts=s16:sample_rates=24000:channel_layouts=mono"

// 発話を切った両端へ掛ける極短いfade。
// 切り口の波形が途中の値のまま鳴き声へ切り替わると、継ぎ目でプツッと鳴るため。
const spliceEdgeFadeSeconds = 0.01

// spliceEdgeFade は発話の区間へ掛ける両端のfadeを組み立てる。
// fadeを2つ入れる余裕が無いほど短い区間には掛けない。
func spliceEdgeFade(chunkSeconds float64) string {
	if chunkSeconds <= 2*spliceEdgeFadeSeconds {
		return ""
	}
	return fmt.Sprintf(
		",afade=t=in:st=0:d=%.3f,afade=t=out:st=%.3f:d=%.3f",
		spliceEdgeFadeSeconds,
		chunkSeconds-spliceEdgeFadeSeconds,
		spliceEdgeFadeSeconds,
	)
}

// buildFilterGraph は発話を挿入位置で切り、間へ鳴き声を挟んで繋ぎ直すfilter graphを作る。
// 重ね合わせ（amix）ではなく差し込み（concat）なので、出力は挿入したぶんだけ長くなる。
// 入力0が発話、入力1以降が insertions と同じ順の鳴き声素材である。
func buildFilterGraph(insertions []ResolvedInsertion, inputDuration float64) string {
	type speechChunk struct {
		startSeconds float64
		endSeconds   float64
	}
	chunks := make([]speechChunk, 0, len(insertions)+1)
	order := make([]string, 0, 2*len(insertions)+1)
	position := 0.0
	for index, insertion := range insertions {
		atSeconds := clampSeconds(insertion.AtSeconds, inputDuration)
		if atSeconds > position {
			order = append(order, fmt.Sprintf("[b%d]", len(chunks)))
			chunks = append(chunks, speechChunk{startSeconds: position, endSeconds: atSeconds})
			position = atSeconds
		}
		order = append(order, fmt.Sprintf("[s%d]", index+1))
	}
	if position < inputDuration {
		order = append(order, fmt.Sprintf("[b%d]", len(chunks)))
		chunks = append(chunks, speechChunk{startSeconds: position, endSeconds: inputDuration})
	}

	var graph strings.Builder
	if len(chunks) > 1 {
		graph.WriteString("[0:a]asplit=" + strconv.Itoa(len(chunks)))
		for index := range chunks {
			fmt.Fprintf(&graph, "[p%d]", index)
		}
		graph.WriteString(";")
	}
	for index, chunk := range chunks {
		source := "[0:a]"
		if len(chunks) > 1 {
			source = fmt.Sprintf("[p%d]", index)
		}
		fmt.Fprintf(
			&graph,
			"%satrim=start=%.3f:end=%.3f,asetpts=N/SR/TB%s,%s[b%d];",
			source,
			chunk.startSeconds,
			chunk.endSeconds,
			spliceEdgeFade(chunk.endSeconds-chunk.startSeconds),
			spliceSampleFormat,
			index,
		)
	}
	for index, insertion := range insertions {
		// 素材は中央値2.3秒・最長5.4秒あるので、差し込む長さまで切り詰める。
		// 終端のfadeは素材の長さを知らずに掛けたいので、反転して先頭へ掛けてから戻す。
		fmt.Fprintf(
			&graph,
			"[%d:a]atrim=end=%.3f,asetpts=N/SR/TB,afade=t=in:st=0:d=%.3f,"+
				"areverse,afade=t=in:st=0:d=%.3f,areverse,%s[s%d];",
			index+1,
			math.Max(0, insertion.DurationSeconds),
			insertionFadeInSeconds,
			insertionFadeOutSeconds,
			spliceSampleFormat,
			index+1,
		)
	}
	graph.WriteString(strings.Join(order, ""))
	fmt.Fprintf(&graph, "concat=n=%d:v=0:a=1[out]", len(order))
	return graph.String()
}

// アニマル度100では、入力音声2秒あたり文中へ1本を目標にする。
// 末尾の1本は密度計算へ含めず、resolveArrangementが別に追加する。
const maximumWordInsertionsPerSecond = 0.5

func validateIntensity(intensity int) error {
	if intensity < 0 || intensity > 100 {
		return fmt.Errorf("intensity must be between 0 and 100")
	}
	return nil
}

func targetWordInsertionCount(inputDuration float64, intensity int) int {
	if inputDuration <= 0 || intensity <= 0 {
		return 0
	}
	return int(math.Round(inputDuration * maximumWordInsertionsPerSecond * float64(intensity) / 100))
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
