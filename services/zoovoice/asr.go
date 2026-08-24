package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

var errASREmpty = errors.New("ASR transcript is empty")

// TranscriptToken はASRが返す最小単位の文字列と、その音声上の時刻。
// whisper.cppは日本語をほぼ1文字ずつへ割るため、これは単語ではなく文字に近い。
// 単語境界はこのtoken列を形態素解析でまとめ直して求める。
type TranscriptToken struct {
	Text         string
	StartSeconds float64
	EndSeconds   float64
}

// Transcript は文字起こし結果。Text は Tokens を連結したものと一致する。
type Transcript struct {
	Text   string
	Tokens []TranscriptToken
}

type transcriber interface {
	Transcribe(context.Context, string) (Transcript, error)
}

type whisperTranscriber struct {
	runner      commandRunner
	commandPath string
	modelPath   string
	threads     int
}

func newWhisperTranscriber(
	runner commandRunner,
	commandPath string,
	modelPath string,
	threads int,
) (*whisperTranscriber, error) {
	if !regularFileExists(commandPath) {
		return nil, fmt.Errorf("ZOOVOICE_WHISPER_COMMAND must be a regular file")
	}
	if !regularFileExists(modelPath) {
		return nil, fmt.Errorf("ZOOVOICE_ASR_MODEL_PATH must be a regular file")
	}
	if threads < 1 {
		return nil, fmt.Errorf("ASR threads must be positive")
	}
	return &whisperTranscriber{
		runner: runner, commandPath: commandPath, modelPath: modelPath, threads: threads,
	}, nil
}

// Transcribe は whisper-cli を -ml 1 で走らせ、token単位の時刻付き文字起こしを取る。
// -ml 1 はsegmentをtoken単位まで刻むので、標準出力の1行が1tokenになる。
// JSON出力(-ojf)でも同じ時刻を取れるが、こちらは一時ファイルを作らずに済む。
func (transcriber *whisperTranscriber) Transcribe(ctx context.Context, wavPath string) (Transcript, error) {
	output, err := transcriber.runner.Run(
		ctx,
		transcriber.commandPath,
		"-ng",
		"-np",
		"-m", transcriber.modelPath,
		"-l", "ja",
		"-ml", "1",
		"-t", strconv.Itoa(transcriber.threads),
		"-f", wavPath,
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Transcript{}, ctxErr
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return Transcript{}, err
		}
		return Transcript{}, fmt.Errorf("whisper command failed: %w", err)
	}
	transcript := parseWhisperTranscript(output.Stdout)
	if transcript.Text == "" {
		return Transcript{}, errASREmpty
	}
	return transcript, nil
}

// whisperSegment は whisper-cli の1行分。Text はUTF-8として不正なbyte断片になり得る。
type whisperSegment struct {
	StartSeconds float64
	EndSeconds   float64
	Text         string
}

// segmentTextSeparator は「[開始 --> 終了]」と本文の間の固定の区切り。
const segmentTextSeparator = "]  "

// parseWhisperTranscript は whisper-cli の標準出力を文字起こしへ直す。
// Text は Tokens をそのまま連結したものにする。単語境界のrune位置から時刻を引くとき、
// Text と Tokens の間に文字のずれがあると位置が狂うためである。
func parseWhisperTranscript(stdout string) Transcript {
	tokens := mergeTranscriptTokens(parseWhisperSegments(stdout))
	var text strings.Builder
	for _, token := range tokens {
		text.WriteString(token.Text)
	}
	return Transcript{Text: text.String(), Tokens: tokens}
}

func parseWhisperSegments(stdout string) []whisperSegment {
	lines := strings.Split(stdout, "\n")
	segments := make([]whisperSegment, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		if !strings.HasPrefix(line, "[") {
			continue
		}
		separator := strings.Index(line, segmentTextSeparator)
		if separator < 0 {
			continue
		}
		times := strings.SplitN(line[1:separator], " --> ", 2)
		if len(times) != 2 {
			continue
		}
		start, startOK := parseWhisperTimestamp(times[0])
		end, endOK := parseWhisperTimestamp(times[1])
		if !startOK || !endOK {
			continue
		}
		segments = append(segments, whisperSegment{
			StartSeconds: start,
			EndSeconds:   end,
			Text:         line[separator+len(segmentTextSeparator):],
		})
	}
	return segments
}

// parseWhisperTimestamp は "00:01:02.340" 形式を秒へ直す。
func parseWhisperTimestamp(value string) (float64, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 3 {
		return 0, false
	}
	hours, hoursErr := strconv.ParseFloat(parts[0], 64)
	minutes, minutesErr := strconv.ParseFloat(parts[1], 64)
	seconds, secondsErr := strconv.ParseFloat(parts[2], 64)
	if hoursErr != nil || minutesErr != nil || secondsErr != nil {
		return 0, false
	}
	if hours < 0 || minutes < 0 || seconds < 0 {
		return 0, false
	}
	return hours*3600 + minutes*60 + seconds, true
}

// mergeTranscriptTokens はUTF-8として成立するまで隣り合うsegmentを連結する。
// whisper.cppは「屋」「鳴」のような漢字を複数tokenへ割ることがあり、
// 1token単独ではUTF-8の途中で切れた不正なbyte列になるため、そのままでは文字として扱えない。
// 連結できた時点で1文字ぶんのtokenとし、開始時刻は最初の断片、終了時刻は最後の断片から取る。
func mergeTranscriptTokens(segments []whisperSegment) []TranscriptToken {
	tokens := make([]TranscriptToken, 0, len(segments))
	var pending strings.Builder
	pendingStart := 0.0
	for _, segment := range segments {
		if segment.Text == "" {
			continue
		}
		if pending.Len() == 0 {
			pendingStart = segment.StartSeconds
		}
		pending.WriteString(segment.Text)
		text := pending.String()
		if !utf8.ValidString(text) {
			continue
		}
		pending.Reset()
		// 前後の空白はtokenから外す。連結したTextと単語境界のrune位置を一致させるため。
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		tokens = append(tokens, TranscriptToken{
			Text:         text,
			StartSeconds: pendingStart,
			EndSeconds:   segment.EndSeconds,
		})
	}
	return tokens
}
