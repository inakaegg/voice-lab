package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"math/rand"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fakeAudioComposer struct {
	result ComposeResult
	err    error
}

func (fake *fakeAudioComposer) Compose(
	_ context.Context,
	_ []byte,
	_ ComposeSettings,
) (ComposeResult, error) {
	return fake.result, fake.err
}

func TestAnimalsEndpointReturnsPublicMetadataWithoutFilenames(t *testing.T) {
	handler := newHTTPHandler(testCatalog(), &fakeAudioComposer{}, log.New(io.Discard, "", 0))
	request := httptest.NewRequest(http.MethodGet, "/animals", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Animals []AnimalSummary `json:"animals"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Animals) != 3 || payload.Animals[0].ID != "cat" {
		t.Fatalf("animals = %#v", payload.Animals)
	}
	if strings.Contains(response.Body.String(), ".wav") || strings.Contains(response.Body.String(), "file") {
		t.Fatalf("private filename leaked: %s", response.Body.String())
	}
}

func TestComposeEndpointReturnsWavEnvelope(t *testing.T) {
	audio := []byte("wav result")
	composer := &fakeAudioComposer{result: ComposeResult{
		AudioBase64:           base64.StdEncoding.EncodeToString(audio),
		Insertions:            []ResolvedInsertion{{Slot: "opening", Species: "dog", AtSeconds: 0}},
		InputDurationSeconds:  2,
		OutputDurationSeconds: 2.3,
	}}
	handler := newHTTPHandler(testCatalog(), composer, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		[]byte("input audio"),
		`{"arrangement":{"opening":"dog","gaps":null,"ending":null},"intensity":50}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Audio struct {
			Format string `json:"format"`
			Base64 string `json:"base64"`
		} `json:"audio"`
		Meta struct {
			Insertions            []ResolvedInsertion `json:"insertions"`
			InputDurationSeconds  float64             `json:"input_duration_seconds"`
			OutputDurationSeconds float64             `json:"output_duration_seconds"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Audio.Format != "wav" || payload.Audio.Base64 != base64.StdEncoding.EncodeToString(audio) {
		t.Fatalf("audio = %#v", payload.Audio)
	}
	if len(payload.Meta.Insertions) != 1 || payload.Meta.Insertions[0].Species != "dog" {
		t.Fatalf("meta = %#v", payload.Meta)
	}
}

func TestComposeEndpointMapsTypedProcessingError(t *testing.T) {
	composer := &fakeAudioComposer{err: &APIError{
		Status:  http.StatusUnprocessableEntity,
		Code:    "speech_too_short",
		Message: "0.5秒以上話した音声を送ってください。",
	}}
	handler := newHTTPHandler(testCatalog(), composer, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		[]byte("input audio"),
		`{"arrangement":{"opening":"dog","gaps":null,"ending":null},"intensity":50}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != "speech_too_short" {
		t.Fatalf("error = %#v", payload.Error)
	}
}

func TestComposeEndpointRejectsTrailingSettingsJSON(t *testing.T) {
	handler := newHTTPHandler(testCatalog(), &fakeAudioComposer{}, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		[]byte("input audio"),
		`{"arrangement":{"opening":"dog","gaps":null,"ending":null},"intensity":50} {}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"code":"invalid_settings"`) {
		t.Fatalf("body = %s", response.Body.String())
	}
}

func TestComposeEndpointWithFFmpegFixture(t *testing.T) {
	for _, binary := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(binary); err != nil {
			t.Skipf("%s is unavailable", binary)
		}
	}
	input, err := os.ReadFile("testdata/compose-input.wav")
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := loadCatalog(
		"assets/animals.json",
		"assets/cc0",
		"",
		log.New(io.Discard, "", 0),
	)
	if err != nil {
		t.Fatal(err)
	}
	composer := newComposer(
		catalog,
		execCommandRunner{},
		rand.New(rand.NewSource(11)),
		30*time.Second,
		log.New(io.Discard, "", 0),
	)
	handler := newHTTPHandler(catalog, composer, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		input,
		`{"arrangement":{"opening":"rooster","gaps":"cow","ending":"rooster"},"intensity":100}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Audio struct {
			Format string `json:"format"`
			Base64 string `json:"base64"`
		} `json:"audio"`
		Meta struct {
			Insertions            []ResolvedInsertion `json:"insertions"`
			InputDurationSeconds  float64             `json:"input_duration_seconds"`
			OutputDurationSeconds float64             `json:"output_duration_seconds"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	output, err := base64.StdEncoding.DecodeString(payload.Audio.Base64)
	if err != nil {
		t.Fatal(err)
	}
	outputPath := filepath.Join(t.TempDir(), "composed.wav")
	if err := os.WriteFile(outputPath, output, 0o644); err != nil {
		t.Fatal(err)
	}
	probe := exec.Command(
		"ffprobe",
		"-v", "error",
		"-select_streams", "a:0",
		"-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
		"-of", "json",
		outputPath,
	)
	probeOutput, err := probe.Output()
	if err != nil {
		t.Fatal(err)
	}
	var media struct {
		Streams []struct {
			CodecName  string `json:"codec_name"`
			SampleRate string `json:"sample_rate"`
			Channels   int    `json:"channels"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(probeOutput, &media); err != nil {
		t.Fatal(err)
	}
	if len(media.Streams) != 1 ||
		media.Streams[0].CodecName != "pcm_s16le" ||
		media.Streams[0].SampleRate != "24000" ||
		media.Streams[0].Channels != 1 {
		t.Fatalf("unexpected output audio: %#v", media.Streams)
	}
	probedDuration, err := strconv.ParseFloat(media.Format.Duration, 64)
	if err != nil {
		t.Fatal(err)
	}
	if len(payload.Meta.Insertions) != 4 {
		t.Fatalf("insertions = %#v, want opening, two gaps, and ending", payload.Meta.Insertions)
	}
	if probedDuration <= payload.Meta.InputDurationSeconds ||
		payload.Meta.OutputDurationSeconds <= payload.Meta.InputDurationSeconds {
		t.Fatalf(
			"ending sound did not extend output: input=%v meta_output=%v probe_output=%v",
			payload.Meta.InputDurationSeconds,
			payload.Meta.OutputDurationSeconds,
			probedDuration,
		)
	}
}

func multipartComposeRequest(t *testing.T, audio []byte, settings string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	audioPart, err := writer.CreateFormFile("audio", "recording.wav")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := audioPart.Write(audio); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("settings", settings); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/compose", &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}
