package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// 連想はLLMへ一本化している。辞書（ConceptNet・WordNet・語彙表）と意味ベクトルの
// 連想経路、および当てずっぽうのrandom選択は廃止した。
// 経緯と実測は docs/speech-translation/ZOOVOICE_ASSOCIATION_CASE_STUDY.md を参照。

type SelectionStrategy string

const strategyLLM SelectionStrategy = "llm"

const (
	defaultAssociationModel    = "gpt-5.6-luna"
	defaultAssociationEndpoint = "https://api.openai.com/v1/responses"
)

// associationInstructions は「必ず1種選ぶ」プロンプト。
// 慎重版のプロンプトは候補に無い動物を聞かれると回答を避けたため、遊びの製品意図に合わなかった。
const associationInstructions = `あなたは日本語の発話から動物を1種連想する担当です。
候補リストの中から、発話に最もふさわしい動物をかならず1種選んでください。
発話に動物が出てこなくても構いません。語呂合わせ・ことわざ・縁起物・情景・比喩など、
どんなこじつけでもよいので必ず1種選び、選んだ理由を日本語60文字以内の短文で書いてください。
「選べない」という回答は禁止です。species には候補リストのidをそのまま使ってください。`

type AnimalSelection struct {
	Species  string            `json:"species"`
	LabelJA  string            `json:"label_ja"`
	Reason   string            `json:"reason"`
	Strategy SelectionStrategy `json:"strategy"`
}

type animalAssociator interface {
	Select(context.Context, string, []availableAnimal) (AnimalSelection, error)
}

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type llmAssociator struct {
	client   httpDoer
	endpoint string
	apiKey   string
	model    string
}

func newLLMAssociator(client httpDoer, endpoint, apiKey, model string) (*llmAssociator, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("OPENAI_API_KEY must be set for animal association")
	}
	if endpoint == "" {
		endpoint = defaultAssociationEndpoint
	}
	if model == "" {
		model = defaultAssociationModel
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &llmAssociator{client: client, endpoint: endpoint, apiKey: apiKey, model: model}, nil
}

type associationCandidate struct {
	ID      string `json:"id"`
	LabelJA string `json:"label_ja"`
}

type associationRequest struct {
	Transcript string                 `json:"transcript"`
	Candidates []associationCandidate `json:"candidates"`
}

type associationAnswer struct {
	Species string `json:"species"`
	Reason  string `json:"reason"`
}

func (a *llmAssociator) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
) (AnimalSelection, error) {
	transcript = strings.TrimSpace(transcript)
	if transcript == "" {
		return AnimalSelection{}, &APIError{
			Status: 422, Code: "asr_empty", Message: "音声から発話を認識できませんでした。",
		}
	}
	if len(animals) == 0 {
		return AnimalSelection{}, fmt.Errorf("no animals are available for association")
	}
	labels := make(map[string]string, len(animals))
	candidates := make([]associationCandidate, 0, len(animals))
	for _, animal := range animals {
		labels[animal.ID] = animal.LabelJA
		candidates = append(candidates, associationCandidate{ID: animal.ID, LabelJA: animal.LabelJA})
	}
	answer, err := a.ask(ctx, associationRequest{Transcript: transcript, Candidates: candidates})
	if err != nil {
		return AnimalSelection{}, err
	}
	labelJA, known := labels[answer.Species]
	if !known {
		return AnimalSelection{}, associationAPIError(
			"動物を選べませんでした。",
			fmt.Errorf("model returned unknown species %q", truncate(answer.Species, 80)),
		)
	}
	return AnimalSelection{
		Species:  answer.Species,
		LabelJA:  labelJA,
		Reason:   strings.TrimSpace(answer.Reason),
		Strategy: strategyLLM,
	}, nil
}

func (a *llmAssociator) ask(ctx context.Context, input associationRequest) (associationAnswer, error) {
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return associationAnswer{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"model":        a.model,
		"instructions": associationInstructions,
		"input":        string(inputJSON),
		"text": map[string]any{
			"format": map[string]any{
				"type":   "json_schema",
				"name":   "zoovoice_animal_association",
				"strict": true,
				"schema": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"species": map[string]any{"type": "string"},
						"reason":  map[string]any{"type": "string"},
					},
					"required":             []string{"species", "reason"},
					"additionalProperties": false,
				},
			},
		},
	})
	if err != nil {
		return associationAnswer{}, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, bytes.NewReader(payload))
	if err != nil {
		return associationAnswer{}, err
	}
	request.Header.Set("Authorization", "Bearer "+a.apiKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := a.client.Do(request)
	if err != nil {
		return associationAnswer{}, associationAPIError("連想に使うAPIへ接続できませんでした。", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return associationAnswer{}, associationAPIError("連想に使うAPIの応答を読めませんでした。", err)
	}
	if response.StatusCode != http.StatusOK {
		return associationAnswer{}, associationAPIError(
			"連想に使うAPIがエラーを返しました。",
			fmt.Errorf("association API returned HTTP %d: %s", response.StatusCode, truncate(string(body), 300)),
		)
	}
	text := outputTextFromResponses(body)
	if text == "" {
		return associationAnswer{}, associationAPIError(
			"連想に使うAPIが空の応答を返しました。", fmt.Errorf("empty output text"),
		)
	}
	var answer associationAnswer
	if err := json.Unmarshal([]byte(text), &answer); err != nil {
		return associationAnswer{}, associationAPIError(
			"連想に使うAPIの応答を解釈できませんでした。",
			fmt.Errorf("parse model output %q: %w", truncate(text, 300), err),
		)
	}
	if answer.Species == "" {
		return associationAnswer{}, associationAPIError(
			"連想に使うAPIが動物を選びませんでした。", fmt.Errorf("model returned an empty species"),
		)
	}
	return answer, nil
}

// outputTextFromResponses はOpenAI Responses APIの本文からテキストを取り出す。
// output_text を優先し、無ければ output[].content[].text を連結する。
func outputTextFromResponses(body []byte) string {
	var parsed struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return ""
	}
	if strings.TrimSpace(parsed.OutputText) != "" {
		return strings.TrimSpace(parsed.OutputText)
	}
	var chunks strings.Builder
	for _, item := range parsed.Output {
		for _, content := range item.Content {
			chunks.WriteString(content.Text)
		}
	}
	return strings.TrimSpace(chunks.String())
}

func associationAPIError(message string, err error) *APIError {
	return &APIError{Status: 502, Code: "association_failed", Message: message, Err: err}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
