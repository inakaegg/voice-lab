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
)

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

func mapIntensity(intensity int) (IntensityConfig, error) {
	if intensity < 0 || intensity > 100 {
		return IntensityConfig{}, fmt.Errorf("intensity must be between 0 and 100")
	}
	minSilence := math.Round((1.2-0.009*float64(intensity))*1000) / 1000
	return IntensityConfig{
		MinSilenceSeconds: minSilence,
		MaxInsertions:     2 + int(math.Round(float64(intensity)*0.08)),
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
