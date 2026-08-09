package main

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
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
	AudioBase64           string
	Transcript            string
	SelectedAnimal        SelectedAnimal
	EvidenceTerm          *string
	SelectionStrategy     SelectionStrategy
	FallbackReason        *string
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
	associator animalAssociator,
	rng *rand.Rand,
	timeout time.Duration,
	logger *log.Logger,
) *composer {
	return &composer{
		catalog:     catalog,
		runner:      runner,
		transcriber: transcriber,
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
	intensity, err := mapIntensity(settings.Intensity)
	if err != nil {
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
	if err := os.WriteFile(inputPath, audio, 0o600); err != nil {
		return ComposeResult{}, internalProcessingError("write uploaded audio", err)
	}

	logProgress(c.logger, started, "probe", "start", "")
	inputDuration, err := c.probeDuration(contextWithTimeout, inputPath)
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
	if durationMetadataAvailable && inputDuration <= 0 {
		return ComposeResult{}, &APIError{
			Status:  422,
			Code:    "invalid_audio",
			Message: "音声ファイルを読み取れませんでした。",
		}
	}
	if durationMetadataAvailable && inputDuration > maxAudioSeconds {
		return ComposeResult{}, validateAudioLimits(int64(len(audio)), inputDuration, minSpeechSeconds)
	}
	if durationMetadataAvailable {
		logProgress(c.logger, started, "probe", "complete", "duration_seconds=%.3f", inputDuration)
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

	if !durationMetadataAvailable {
		logProgress(c.logger, started, "normalized_probe", "start", "")
		inputDuration, err = c.probeDuration(contextWithTimeout, normalizedPath)
		if err != nil || inputDuration <= 0 {
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
	}

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

	logProgress(
		c.logger,
		started,
		"silence_detect",
		"start",
		"minimum_seconds=%.3f",
		intensity.MinSilenceSeconds,
	)
	gaps, err := c.detectSilences(
		contextWithTimeout,
		normalizedPath,
		inputDuration,
		intensity.MinSilenceSeconds,
	)
	if err != nil {
		return ComposeResult{}, c.commandAPIError(
			contextWithTimeout,
			started,
			"silence_detect",
			500,
			"audio_processing_failed",
			"無音区間を検出できませんでした。",
			err,
		)
	}
	logProgress(c.logger, started, "silence_detect", "complete", "gap_count=%d", len(gaps))

	logProgress(c.logger, started, "asr_audio", "start", "")
	if err := c.prepareASRAudio(contextWithTimeout, normalizedPath, asrPath); err != nil {
		return ComposeResult{}, c.privateStageAPIError(
			contextWithTimeout, started, "asr_audio", "asr_failed", "音声を文字に変換できませんでした。", err,
		)
	}
	logProgress(c.logger, started, "asr_audio", "complete", "")

	logProgress(c.logger, started, "asr", "start", "")
	transcript, err := c.transcriber.Transcribe(contextWithTimeout, asrPath)
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

	var insertions []ResolvedInsertion
	c.rngMu.Lock()
	selection, err := c.associator.Select(contextWithTimeout, transcript, c.catalog.Animals, c.rng)
	if err == nil {
		var arrangementErr error
		insertions, arrangementErr = resolveArrangement(
			c.catalog,
			selection.Species,
			settings.Intensity,
			gaps,
			inputDuration,
			c.rng,
		)
		err = arrangementErr
	}
	c.rngMu.Unlock()
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
		c.logger, started, "association", "complete", "species=%s strategy=%s", selection.Species, selection.Strategy,
	)

	var outputAudio []byte
	outputDuration := inputDuration
	if len(insertions) == 0 {
		outputAudio, err = os.ReadFile(normalizedPath)
		if err != nil {
			return ComposeResult{}, internalProcessingError("read normalized output", err)
		}
	} else {
		logProgress(c.logger, started, "compose", "start", "insertion_count=%d", len(insertions))
		if err := c.mix(contextWithTimeout, normalizedPath, outputPath, insertions); err != nil {
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
		outputAudio, err = os.ReadFile(outputPath)
		if err != nil {
			return ComposeResult{}, internalProcessingError("read composed output", err)
		}
		logProgress(c.logger, started, "compose", "complete", "output_seconds=%.3f", outputDuration)
	}

	insertionPaths := make([]string, 0, len(insertions))
	for _, insertion := range insertions {
		insertionPaths = append(insertionPaths, insertion.AssetPath)
	}
	logProgress(c.logger, started, "request", "complete", "output_bytes=%d", len(outputAudio))
	return ComposeResult{
		AudioBase64:           base64.StdEncoding.EncodeToString(outputAudio),
		Transcript:            transcript,
		SelectedAnimal:        SelectedAnimal{ID: selection.Species, LabelJA: selection.LabelJA},
		EvidenceTerm:          optionalString(selection.EvidenceTerm),
		SelectionStrategy:     selection.Strategy,
		FallbackReason:        optionalString(selection.FallbackReason),
		Insertions:            insertions,
		SoundCredits:          c.catalog.creditsForPaths(insertionPaths),
		InputDurationSeconds:  roundSeconds(inputDuration),
		OutputDurationSeconds: roundSeconds(outputDuration),
	}, nil
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
) error {
	args := []string{"-nostdin", "-y", "-v", "error", "-i", normalizedPath}
	for _, insertion := range insertions {
		args = append(args, "-i", insertion.AssetPath)
	}
	args = append(
		args,
		"-filter_complex", buildFilterGraph(insertions),
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
