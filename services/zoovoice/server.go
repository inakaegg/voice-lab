package main

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

const (
	maxMultipartOverhead = 128 * 1024
	maxSettingsBytes     = 64 * 1024
)

type httpAPI struct {
	catalog  *assetCatalog
	composer audioComposer
	logger   *log.Logger
}

func newHTTPHandler(
	catalog *assetCatalog,
	composer audioComposer,
	logger *log.Logger,
) http.Handler {
	api := &httpAPI{catalog: catalog, composer: composer, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", api.health)
	mux.HandleFunc("/animals", api.animals)
	mux.HandleFunc("/compose", api.compose)
	return mux
}

func (api *httpAPI) health(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, &APIError{Status: 405, Code: "method_not_allowed", Message: "GETを使用してください。"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{"status": "ok"})
}

func (api *httpAPI) animals(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeError(writer, &APIError{Status: 405, Code: "method_not_allowed", Message: "GETを使用してください。"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"animals": api.catalog.publicAnimals()})
}

func (api *httpAPI) compose(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeError(writer, &APIError{Status: 405, Code: "method_not_allowed", Message: "POSTを使用してください。"})
		return
	}
	started := time.Now()
	logProgress(api.logger, started, "http", "start", "method=POST path=/compose")
	audio, settings, err := readComposeRequest(writer, request)
	if err != nil {
		writeError(writer, err)
		logProgress(api.logger, started, "http", "rejected", "code=%s", err.Code)
		return
	}
	result, composeErr := api.composer.Compose(request.Context(), audio, settings)
	if composeErr != nil {
		var apiError *APIError
		if !errors.As(composeErr, &apiError) {
			apiError = &APIError{
				Status:  500,
				Code:    "internal_error",
				Message: "音声を合成できませんでした。",
				Err:     composeErr,
			}
		}
		writeError(writer, apiError)
		logProgress(api.logger, started, "http", "failed", "code=%s", apiError.Code)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"audio": map[string]any{
			"format": "wav",
			"base64": result.AudioBase64,
		},
		"meta": map[string]any{
			"transcript":              result.Transcript,
			"selected_animal":         result.SelectedAnimal,
			"evidence_term":           result.EvidenceTerm,
			"selection_strategy":      result.SelectionStrategy,
			"fallback_reason":         result.FallbackReason,
			"insertions":              result.Insertions,
			"sound_credits":           result.SoundCredits,
			"input_duration_seconds":  result.InputDurationSeconds,
			"output_duration_seconds": result.OutputDurationSeconds,
		},
	})
	logProgress(api.logger, started, "http", "complete", "status=200")
}

func readComposeRequest(
	writer http.ResponseWriter,
	request *http.Request,
) ([]byte, ComposeSettings, *APIError) {
	maxRequestBytes := maxAudioBytes + maxMultipartOverhead
	if request.ContentLength > maxRequestBytes {
		return nil, ComposeSettings{}, &APIError{
			Status:  413,
			Code:    "audio_too_large",
			Message: "音声ファイルは10MB以下にしてください。",
		}
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBytes)
	reader, err := request.MultipartReader()
	if err != nil {
		return nil, ComposeSettings{}, &APIError{
			Status:  400,
			Code:    "invalid_multipart",
			Message: "multipart形式で音声と設定を送ってください。",
			Err:     err,
		}
	}

	var audio []byte
	var settingsPayload []byte
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(nextErr, &maxBytesError) {
				return nil, ComposeSettings{}, &APIError{
					Status:  413,
					Code:    "audio_too_large",
					Message: "音声ファイルは10MB以下にしてください。",
					Err:     nextErr,
				}
			}
			return nil, ComposeSettings{}, invalidMultipartError(nextErr)
		}
		switch part.FormName() {
		case "audio":
			if len(audio) != 0 || part.FileName() == "" {
				part.Close()
				return nil, ComposeSettings{}, invalidMultipartError(errors.New("audio must be one file"))
			}
			audio, err = readLimitedPart(part, maxAudioBytes)
			if err != nil {
				part.Close()
				if errors.Is(err, errPartTooLarge) {
					return nil, ComposeSettings{}, &APIError{
						Status:  413,
						Code:    "audio_too_large",
						Message: "音声ファイルは10MB以下にしてください。",
						Err:     err,
					}
				}
				return nil, ComposeSettings{}, invalidMultipartError(err)
			}
		case "settings":
			if len(settingsPayload) != 0 {
				part.Close()
				return nil, ComposeSettings{}, invalidMultipartError(errors.New("settings must appear once"))
			}
			settingsPayload, err = readLimitedPart(part, maxSettingsBytes)
			if err != nil {
				part.Close()
				return nil, ComposeSettings{}, invalidMultipartError(err)
			}
		default:
			_, err = io.Copy(io.Discard, part)
		}
		part.Close()
		if err != nil {
			return nil, ComposeSettings{}, invalidMultipartError(err)
		}
	}
	if len(audio) == 0 || len(settingsPayload) == 0 {
		return nil, ComposeSettings{}, invalidMultipartError(errors.New("audio and settings are required"))
	}
	settings, parseErr := parseComposeSettings(settingsPayload)
	if parseErr != nil {
		return nil, ComposeSettings{}, parseErr
	}
	return audio, settings, nil
}

var errPartTooLarge = errors.New("multipart field is too large")

func readLimitedPart(part *multipart.Part, maximum int64) ([]byte, error) {
	payload, err := io.ReadAll(io.LimitReader(part, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > maximum {
		return nil, errPartTooLarge
	}
	return payload, nil
}

func parseComposeSettings(payload []byte) (ComposeSettings, *APIError) {
	var wire struct {
		Intensity *int `json:"intensity"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return ComposeSettings{}, invalidSettingsError(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ComposeSettings{}, invalidSettingsError(errors.New("settings must contain one JSON value"))
	}
	if wire.Intensity == nil {
		return ComposeSettings{}, invalidSettingsError(errors.New("intensity is required"))
	}
	if _, err := mapIntensity(*wire.Intensity); err != nil {
		return ComposeSettings{}, invalidSettingsError(err)
	}
	return ComposeSettings{Intensity: *wire.Intensity}, nil
}

func invalidMultipartError(err error) *APIError {
	return &APIError{
		Status:  400,
		Code:    "invalid_multipart",
		Message: "音声ファイルと設定を確認してください。",
		Err:     err,
	}
}

func invalidSettingsError(err error) *APIError {
	return &APIError{
		Status:  400,
		Code:    "invalid_settings",
		Message: "アニマル度の設定を確認してください。",
		Err:     err,
	}
}

func writeError(writer http.ResponseWriter, err *APIError) {
	writeJSON(writer, err.Status, map[string]any{
		"error": map[string]string{
			"code":    err.Code,
			"message": err.Message,
		},
	})
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	if err := json.NewEncoder(writer).Encode(payload); err != nil {
		return
	}
}
