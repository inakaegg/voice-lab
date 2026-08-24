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
		Transcript:            "犬が公園を走っています",
		SelectedAnimal:        SelectedAnimal{ID: "dog", LabelJA: "犬"},
		AssociationReason:     "犬が出てくるため",
		Insertions:            []ResolvedInsertion{{Slot: slotWord, Species: "dog", AtSeconds: 1}},
		SoundCredits:          []soundCredit{{License: "CC0 1.0", Creator: "someone", SourceURL: "https://example.com/dog"}},
		InputDurationSeconds:  2,
		OutputDurationSeconds: 2.3,
	}}
	handler := newHTTPHandler(testCatalog(), composer, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		[]byte("input audio"),
		`{"intensity":50}`,
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
			Transcript            string              `json:"transcript"`
			SelectedAnimal        SelectedAnimal      `json:"selected_animal"`
			AssociationReason     string              `json:"association_reason"`
			Insertions            []ResolvedInsertion `json:"insertions"`
			SoundCredits          []soundCredit       `json:"sound_credits"`
			InputDurationSeconds  float64             `json:"input_duration_seconds"`
			OutputDurationSeconds float64             `json:"output_duration_seconds"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Meta.SoundCredits) != 1 || payload.Meta.SoundCredits[0].License != "CC0 1.0" {
		t.Fatalf("sound credits = %#v", payload.Meta.SoundCredits)
	}
	if payload.Audio.Format != "wav" || payload.Audio.Base64 != base64.StdEncoding.EncodeToString(audio) {
		t.Fatalf("audio = %#v", payload.Audio)
	}
	if len(payload.Meta.Insertions) != 1 || payload.Meta.Insertions[0].Species != "dog" {
		t.Fatalf("meta = %#v", payload.Meta)
	}
	if payload.Meta.Transcript != "犬が公園を走っています" ||
		payload.Meta.SelectedAnimal.ID != "dog" ||
		payload.Meta.AssociationReason != "犬が出てくるため" {
		t.Fatalf("association meta = %#v", payload.Meta)
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
		`{"intensity":50}`,
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
		`{"intensity":50} {}`,
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

func TestParseComposeSettingsAcceptsOnlyIntegerIntensity(t *testing.T) {
	settings, apiError := parseComposeSettings([]byte(`{"intensity":50}`))
	if apiError != nil {
		t.Fatal(apiError)
	}
	// animal_count を省略した古い呼び出しも通り、既定の1になる。
	if settings.Intensity != 50 || settings.AnimalCount != defaultAnimalCount {
		t.Fatalf("settings = %#v", settings)
	}
	for _, payload := range []string{
		`{}`,
		`{"intensity":50.5}`,
		`{"intensity":-1}`,
		`{"intensity":101}`,
		`{"intensity":50,"extra":true}`,
		`{"arrangement":{"opening":"dog"},"intensity":50}`,
		`{"intensity":50,"animal_count":0}`,
		`{"intensity":50,"animal_count":3}`,
		`{"intensity":50,"animal_count":1.5}`,
	} {
		if _, apiError := parseComposeSettings([]byte(payload)); apiError == nil || apiError.Code != "invalid_settings" {
			t.Errorf("payload %s error = %#v", payload, apiError)
		}
	}
}

// 動物の種類数は画面のトグルで選ぶ。既定は1で、2まで受け付ける。
func TestParseComposeSettingsAcceptsAnimalCount(t *testing.T) {
	for _, test := range []struct {
		payload string
		want    int
	}{
		{payload: `{"intensity":50}`, want: 1},
		{payload: `{"intensity":50,"animal_count":1}`, want: 1},
		{payload: `{"intensity":50,"animal_count":2}`, want: 2},
	} {
		settings, apiError := parseComposeSettings([]byte(test.payload))
		if apiError != nil {
			t.Fatalf("payload %s: %v", test.payload, apiError)
		}
		if settings.AnimalCount != test.want {
			t.Errorf("payload %s animal count = %d, want %d", test.payload, settings.AnimalCount, test.want)
		}
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
	catalog := fixtureCatalog(t)
	composer := newComposer(
		catalog,
		execCommandRunner{},
		fixedTranscriber{
			transcript: "鶏が朝に鳴いています",
			tokens:     evenTokens("鶏が朝に鳴いています", 0.2, 0.35),
		},
		newTestSegmenter(t),
		fixedAssociator{selection: AnimalSelection{
			Species: "rooster", LabelJA: "鶏", Reason: "朝の鳴き声といえば鶏", Strategy: strategyLLM,
		}},
		rand.New(rand.NewSource(11)),
		30*time.Second,
		log.New(io.Discard, "", 0),
	)
	handler := newHTTPHandler(catalog, composer, log.New(io.Discard, "", 0))
	request := multipartComposeRequest(
		t,
		input,
		`{"intensity":100}`,
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
	insertions := payload.Meta.Insertions
	if len(insertions) < 2 {
		t.Fatalf("insertions = %#v, want word insertions and an ending", insertions)
	}
	if insertions[0].Slot != slotWord || insertions[0].AtSeconds <= 0 {
		t.Fatalf("first insertion = %+v, want a word insertion after the opening", insertions[0])
	}
	ending := insertions[len(insertions)-1]
	if ending.Slot != slotEnding || ending.AtSeconds != payload.Meta.InputDurationSeconds {
		t.Fatalf("ending insertion = %+v", ending)
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

func stringPointer(value string) *string {
	return &value
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
