package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const speechDetectionMinSilenceSeconds = 0.05

var errDurationUnavailable = errors.New("audio duration metadata is unavailable")

type ComposeResult struct {
	AudioBase64 string
	Transcript  string
	// Words は文字起こしを形態素へ割った結果。挿入位置が単語の切れ目かをCLIで確かめるために持つ。
	Words []string
	// SelectedAnimal と AssociationReason は1件目。既存の利用側のために残している。
	SelectedAnimal        SelectedAnimal
	SelectedAnimals       []AnimalChoice
	AssociationReason     string
	Insertions            []ResolvedInsertion
	SoundCredits          []soundCredit
	InputDurationSeconds  float64
	OutputDurationSeconds float64
}

type audioComposer interface {
	Compose(context.Context, []byte, ComposeSettings) (ComposeResult, error)
}

type composer struct {
	catalog     *assetCatalog
	runner      commandRunner
	transcriber transcriber
	segmenter   wordSegmenter
	associator  animalAssociator
	rng         *rand.Rand
	rngMu       sync.Mutex
	timeout     time.Duration
	logger      *log.Logger
}

func newComposer(
	catalog *assetCatalog,
	runner commandRunner,
	transcriber transcriber,
	segmenter wordSegmenter,
	associator animalAssociator,
	rng *rand.Rand,
	timeout time.Duration,
	logger *log.Logger,
) *composer {
	return &composer{
		catalog:     catalog,
		runner:      runner,
		transcriber: transcriber,
		segmenter:   segmenter,
		associator:  associator,
		rng:         rng,
		timeout:     timeout,
		logger:      logger,
	}
}

func (c *composer) Compose(
	parentContext context.Context,
	audio []byte,
	settings ComposeSettings,
) (ComposeResult, error) {
	started := time.Now()
	logProgress(c.logger, started, "request", "start", "input_bytes=%d intensity=%d", len(audio), settings.Intensity)
	if int64(len(audio)) > maxAudioBytes {
		return ComposeResult{}, validateAudioLimits(int64(len(audio)), 0, minSpeechSeconds)
	}
	if err := validateIntensity(settings.Intensity); err != nil {
		return ComposeResult{}, &APIError{
			Status:  400,
			Code:    "invalid_settings",
			Message: "アニマル度は0から100で指定してください。",
			Err:     err,
		}
	}

	contextWithTimeout, cancel := context.WithTimeout(parentContext, c.timeout)
	defer cancel()
	workDir, err := os.MkdirTemp("", "zoovoice-compose-*")
	if err != nil {
		return ComposeResult{}, internalProcessingError("create temporary workspace", err)
	}
	defer os.RemoveAll(workDir)

	inputPath := filepath.Join(workDir, "input.audio")
	normalizedPath := filepath.Join(workDir, "normalized.wav")
	asrPath := filepath.Join(workDir, "asr.wav")
	outputPath := filepath.Join(workDir, "composed.wav")
	leveledPath := filepath.Join(workDir, "leveled.wav")
	if err := os.WriteFile(inputPath, audio, 0o600); err != nil {
		return ComposeResult{}, internalProcessingError("write uploaded audio", err)
	}

	logProgress(c.logger, started, "probe", "start", "")
	sourceDuration, err := c.probeDuration(contextWithTimeout, inputPath)
	durationMetadataAvailable := err == nil
	if err != nil && !errors.Is(err, errDurationUnavailable) {
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"probe",
			422,
			"invalid_audio",
			"音声ファイルを読み取れませんでした。",
			err,
		)
	}
	if durationMetadataAvailable && !(sourceDuration > 0) {
		return ComposeResult{}, &APIError{
			Status:  422,
			Code:    "invalid_audio",
			Message: "音声ファイルを読み取れませんでした。",
		}
	}
	if durationMetadataAvailable && sourceDuration > maxAudioSeconds {
		return ComposeResult{}, validateAudioLimits(int64(len(audio)), sourceDuration, minSpeechSeconds)
	}
	if durationMetadataAvailable {
		logProgress(c.logger, started, "probe", "complete", "duration_seconds=%.3f", sourceDuration)
	} else {
		logProgress(c.logger, started, "probe", "metadata_unavailable", "")
	}

	logProgress(c.logger, started, "normalize", "start", "")
	if err := c.normalize(contextWithTimeout, inputPath, normalizedPath); err != nil {
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"normalize",
			422,
			"invalid_audio",
			"音声ファイルを変換できませんでした。",
			err,
		)
	}
	logProgress(c.logger, started, "normalize", "complete", "")

	// splice位置と密度の正本は、container metadataではなく実際にspliceする正規化済みWAVの長さにする。
	logProgress(c.logger, started, "normalized_probe", "start", "")
	inputDuration, err := c.probeDuration(contextWithTimeout, normalizedPath)
	if err != nil || !(inputDuration > 0) {
		if err == nil {
			err = errors.New("normalized audio duration must be positive")
		}
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"normalized_probe",
			422,
			"invalid_audio",
			"音声ファイルを読み取れませんでした。",
			err,
		)
	}
	if inputDuration > maxAudioSeconds {
		return ComposeResult{}, validateAudioLimits(int64(len(audio)), inputDuration, minSpeechSeconds)
	}
	logProgress(
		c.logger,
		started,
		"normalized_probe",
		"complete",
		"duration_seconds=%.3f",
		inputDuration,
	)

	logProgress(c.logger, started, "speech_check", "start", "")
	speechSilences, err := c.detectSilences(
		contextWithTimeout,
		normalizedPath,
		inputDuration,
		speechDetectionMinSilenceSeconds,
	)
	if err != nil {
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"speech_check",
			500,
			"audio_processing_failed",
			"音声を解析できませんでした。",
			err,
		)
	}
	speechDuration := nonSilenceDuration(inputDuration, speechSilences)
	if err := validateAudioLimits(int64(len(audio)), inputDuration, speechDuration); err != nil {
		logProgress(c.logger, started, "speech_check", "rejected", "speech_seconds=%.3f", speechDuration)
		return ComposeResult{}, err
	}
	logProgress(c.logger, started, "speech_check", "complete", "speech_seconds=%.3f", speechDuration)

	logProgress(c.logger, started, "asr_audio", "start", "")
	if err := c.prepareASRAudio(contextWithTimeout, normalizedPath, asrPath); err != nil {
		return ComposeResult{}, c.privateStageAPIError(
			contextWithTimeout, started, "asr_audio", "asr_failed", "音声を文字に変換できませんでした。", err,
		)
	}
	logProgress(c.logger, started, "asr_audio", "complete", "")

	logProgress(c.logger, started, "asr", "start", "")
	transcription, err := c.transcriber.Transcribe(contextWithTimeout, asrPath)
	if err != nil {
		code := "asr_failed"
		message := "音声を文字に変換できませんでした。"
		status := 500
		if errors.Is(err, errASREmpty) {
			code = "asr_empty"
			message = "音声から発話を認識できませんでした。"
			status = 422
		}
		return ComposeResult{}, c.privateStageAPIErrorWithStatus(
			contextWithTimeout, started, "asr", status, code, message, err,
		)
	}
	logProgress(c.logger, started, "asr", "complete", "")

	// 日本語は一息で話しても無音がほとんど出ないため、挿入位置は無音ではなく単語の切れ目から選ぶ。
	words := c.segmenter.SplitWords(transcription.Text)
	boundaries := insertionBoundaries(words, transcription.Tokens, inputDuration)
	logProgress(
		c.logger, started, "word_split", "complete",
		"word_count=%d boundary_count=%d", len(words), len(boundaries),
	)

	var insertions []ResolvedInsertion
	selections, err := c.associator.Select(
		contextWithTimeout, transcription.Text, c.catalog.Animals, animalCount(settings),
	)
	if err == nil {
		c.rngMu.Lock()
		insertions, err = resolveArrangement(
			c.catalog,
			speciesIDs(selections),
			settings.Intensity,
			boundaries,
			inputDuration,
			c.rng,
		)
		c.rngMu.Unlock()
	}
	if err != nil {
		var apiError *APIError
		if !errors.As(err, &apiError) {
			apiError = &APIError{Status: 500, Code: "association_failed", Message: "動物を選べませんでした。", Err: err}
		}
		return ComposeResult{}, c.privateStageAPIErrorWithStatus(
			contextWithTimeout,
			started,
			"association",
			apiError.Status,
			apiError.Code,
			apiError.Message,
			apiError,
		)
	}
	logProgress(
		c.logger, started, "association", "complete",
		"species=%s count=%d", selections[0].Species, len(selections),
	)

	finalPath := normalizedPath
	outputDuration := inputDuration
	if len(insertions) > 0 {
		logProgress(c.logger, started, "compose", "start", "insertion_count=%d", len(insertions))
		if err := c.resolveInsertionDurations(contextWithTimeout, insertions); err != nil {
			return ComposeResult{}, c.commandAPIError(
				contextWithTimeout,
				started,
				"compose",
				500,
				"audio_processing_failed",
				"動物の鳴き声を確認できませんでした。",
				err,
			)
		}
		if err := c.mix(contextWithTimeout, normalizedPath, outputPath, insertions, inputDuration); err != nil {
			return ComposeResult{}, c.commandAPIError(
				contextWithTimeout,
				started,
				"compose",
				500,
				"audio_processing_failed",
				"動物の鳴き声を合成できませんでした。",
				err,
			)
		}
		outputDuration, err = c.probeDuration(contextWithTimeout, outputPath)
		if err != nil {
			return ComposeResult{}, c.commandAPIError(
				contextWithTimeout,
				started,
				"output_probe",
				500,
				"audio_processing_failed",
				"合成した音声を確認できませんでした。",
				err,
			)
		}
		finalPath = outputPath
		logProgress(c.logger, started, "compose", "complete", "output_seconds=%.3f", outputDuration)
	}

	logProgress(c.logger, started, "loudness", "start", "")
	finalPath, gainDB, err := c.applyLoudnessCeiling(contextWithTimeout, finalPath, leveledPath)
	if err != nil {
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"loudness",
			500,
			"audio_processing_failed",
			"合成した音声の音量を調整できませんでした。",
			err,
		)
	}
	logProgress(c.logger, started, "loudness", "complete", "gain_db=%.1f", gainDB)

	outputAudio, err := os.ReadFile(finalPath)
	if err != nil {
		return ComposeResult{}, internalProcessingError("read composed output", err)
	}

	insertionPaths := make([]string, 0, len(insertions))
	for _, insertion := range insertions {
		insertionPaths = append(insertionPaths, insertion.AssetPath)
	}
	logProgress(c.logger, started, "request", "complete", "output_bytes=%d", len(outputAudio))
	return ComposeResult{
		AudioBase64:           base64.StdEncoding.EncodeToString(outputAudio),
		Transcript:            transcription.Text,
		Words:                 words,
		SelectedAnimal:        SelectedAnimal{ID: selections[0].Species, LabelJA: selections[0].LabelJA},
		SelectedAnimals:       animalChoices(selections),
		AssociationReason:     selections[0].Reason,
		Insertions:            insertions,
		SoundCredits:          c.catalog.creditsForPaths(insertionPaths),
		InputDurationSeconds:  roundSeconds(inputDuration),
		OutputDurationSeconds: roundSeconds(outputDuration),
	}, nil
}

// animalCount は設定から動物の種類数を読む。未指定（0）は既定の1にする。
func animalCount(settings ComposeSettings) int {
	if settings.AnimalCount < 1 {
		return defaultAnimalCount
	}
	return settings.AnimalCount
}

func speciesIDs(selections []AnimalSelection) []string {
	species := make([]string, 0, len(selections))
	for _, selection := range selections {
		species = append(species, selection.Species)
	}
	return species
}

func animalChoices(selections []AnimalSelection) []AnimalChoice {
	choices := make([]AnimalChoice, 0, len(selections))
	for _, selection := range selections {
		choices = append(choices, AnimalChoice{
			ID: selection.Species, LabelJA: selection.LabelJA, Reason: selection.Reason,
		})
	}
	return choices
}

func (c *composer) prepareASRAudio(ctx context.Context, normalizedPath, outputPath string) error {
	output, err := c.runner.Run(
		ctx,
		"ffmpeg",
		"-nostdin",
		"-y",
		"-v", "error",
		"-i", normalizedPath,
		"-ar", "16000",
		"-ac", "1",
		"-c:a", "pcm_s16le",
		outputPath,
	)
	if err != nil {
		return fmt.Errorf("prepare ASR audio: %w: %s", err, compactCommandError(output.Stderr))
	}
	return nil
}

func (c *composer) privateStageAPIError(
	ctx context.Context,
	started time.Time,
	stage string,
	code string,
	message string,
	err error,
) error {
	return c.privateStageAPIErrorWithStatus(ctx, started, stage, 500, code, message, err)
}

func (c *composer) privateStageAPIErrorWithStatus(
	ctx context.Context,
	started time.Time,
	stage string,
	status int,
	code string,
	message string,
	err error,
) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		status, code, message = 500, "processing_timeout", "音声処理が時間内に完了しませんでした。"
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		status, code, message = 500, "processing_cancelled", "音声処理が中断されました。"
	}
	logProgress(c.logger, started, stage, "failed", "code=%s", code)
	return &APIError{Status: status, Code: code, Message: message, Err: err}
}

func optionalString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func (c *composer) probeDuration(ctx context.Context, path string) (float64, error) {
	output, err := c.runner.Run(
		ctx,
		"ffprobe",
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "default=noprint_wrappers=1:nokey=1",
		path,
	)
	if err != nil {
		return 0, fmt.Errorf("ffprobe failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	rawDuration := strings.TrimSpace(output.Stdout)
	if rawDuration == "" || rawDuration == "N/A" {
		return 0, errDurationUnavailable
	}
	duration, err := strconv.ParseFloat(rawDuration, 64)
	if err != nil {
		return 0, fmt.Errorf("parse ffprobe duration %q: %w", rawDuration, err)
	}
	return duration, nil
}

// resolveInsertionDurations はslotごとの上限と素材実長の短い方を、応答とfilter graphが
// 共通で使うDurationSecondsへ確定する。同じ素材は1request中に1回だけ測る。
func (c *composer) resolveInsertionDurations(ctx context.Context, insertions []ResolvedInsertion) error {
	durationsByPath := make(map[string]float64, len(insertions))
	for index := range insertions {
		assetPath := insertions[index].AssetPath
		assetDuration, known := durationsByPath[assetPath]
		if !known {
			var err error
			assetDuration, err = c.probeDuration(ctx, assetPath)
			if err != nil {
				return fmt.Errorf("probe insertion audio %q: %w", filepath.Base(assetPath), err)
			}
			durationsByPath[assetPath] = assetDuration
		}
		insertions[index].DurationSeconds = roundSeconds(math.Min(
			insertions[index].DurationSeconds,
			assetDuration,
		))
	}
	return nil
}

func (c *composer) normalize(ctx context.Context, inputPath, outputPath string) error {
	output, err := c.runner.Run(
		ctx,
		"ffmpeg",
		"-nostdin",
		"-y",
		"-v", "error",
		"-i", inputPath,
		"-ar", "24000",
		"-ac", "1",
		"-c:a", "pcm_s16le",
		outputPath,
	)
	if err != nil {
		return fmt.Errorf("ffmpeg normalize failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	return nil
}

func (c *composer) detectSilences(
	ctx context.Context,
	path string,
	duration float64,
	minSilence float64,
) ([]SilenceInterval, error) {
	filter := fmt.Sprintf(
		"silencedetect=noise=%s:d=%.3f",
		silenceNoiseThreshold,
		minSilence,
	)
	output, err := c.runner.Run(
		ctx,
		"ffmpeg",
		"-nostdin",
		"-hide_banner",
		"-nostats",
		"-i", path,
		"-af", filter,
		"-f", "null",
		"-",
	)
	if err != nil {
		return nil, fmt.Errorf("ffmpeg silencedetect failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	return parseSilenceDetect(output.Stderr, duration), nil
}

func (c *composer) mix(
	ctx context.Context,
	normalizedPath string,
	outputPath string,
	insertions []ResolvedInsertion,
	inputDuration float64,
) error {
	args := []string{"-nostdin", "-y", "-v", "error", "-i", normalizedPath}
	for _, insertion := range insertions {
		args = append(args, "-i", insertion.AssetPath)
	}
	args = append(
		args,
		"-filter_complex", buildFilterGraph(insertions, inputDuration),
		"-map", "[out]",
		"-ar", "24000",
		"-ac", "1",
		"-c:a", "pcm_s16le",
		outputPath,
	)
	output, err := c.runner.Run(ctx, "ffmpeg", args...)
	if err != nil {
		return fmt.Errorf("ffmpeg compose failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	return nil
}

// applyLoudnessCeiling は完成音声をEBU R128で測り、目標より大きければ静的gainで下げる。
// 人間の発話と鳴き声を混ぜた後の全体へ一律に掛ける。limiterは使わない。
// 調整が要らなかった場合は入力のパスをそのまま返す。
func (c *composer) applyLoudnessCeiling(
	ctx context.Context,
	inputPath string,
	outputPath string,
) (string, float64, error) {
	measurement, err := c.measureLoudness(ctx, inputPath)
	if err != nil {
		return "", 0, err
	}
	gainDB := loudnessGainDB(measurement)
	if gainDB == 0 {
		return inputPath, 0, nil
	}
	output, err := c.runner.Run(
		ctx,
		"ffmpeg",
		"-nostdin",
		"-y",
		"-v", "error",
		"-i", inputPath,
		"-af", fmt.Sprintf("volume=%.1fdB", gainDB),
		"-ar", "24000",
		"-ac", "1",
		"-c:a", "pcm_s16le",
		outputPath,
	)
	if err != nil {
		return "", 0, fmt.Errorf("ffmpeg loudness gain failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	return outputPath, gainDB, nil
}

func (c *composer) measureLoudness(ctx context.Context, path string) (loudnessMeasurement, error) {
	output, err := c.runner.Run(
		ctx,
		"ffmpeg",
		"-nostdin",
		"-hide_banner",
		"-nostats",
		"-i", path,
		"-af", "ebur128=peak=true",
		"-f", "null",
		"-",
	)
	if err != nil {
		return loudnessMeasurement{}, fmt.Errorf("ffmpeg ebur128 failed: %w: %s", err, compactCommandError(output.Stderr))
	}
	return parseLoudnessSummary(output.Stderr), nil
}

func (c *composer) commandAPIError(
	ctx context.Context,
	started time.Time,
	stage string,
	status int,
	code string,
	message string,
	err error,
) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		status = 500
		code = "processing_timeout"
		message = "音声処理が時間内に完了しませんでした。"
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		status = 500
		code = "processing_cancelled"
		message = "音声処理が中断されました。"
	}
	logProgress(c.logger, started, stage, "failed", "code=%s", code)
	return &APIError{
		Status:  status,
		Code:    code,
		Message: message,
		Err:     err,
	}
}

func internalProcessingError(operation string, err error) *APIError {
	return &APIError{
		Status:  500,
		Code:    "internal_error",
		Message: "音声処理を開始できませんでした。",
		Err:     fmt.Errorf("%s: %w", operation, err),
	}
}

func nonSilenceDuration(duration float64, silences []SilenceInterval) float64 {
	silentDuration := 0.0
	for _, silence := range silences {
		if silence.End > silence.Start {
			silentDuration += silence.End - silence.Start
		}
	}
	return max(0, duration-silentDuration)
}

func roundSeconds(value float64) float64 {
	parsed, _ := strconv.ParseFloat(fmt.Sprintf("%.3f", value), 64)
	return parsed
}

func compactCommandError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	const maximumLength = 500
	if len(value) > maximumLength {
		return value[:maximumLength] + "…"
	}
	return value
}
