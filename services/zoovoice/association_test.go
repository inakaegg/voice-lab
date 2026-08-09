package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type stubDoer struct {
	response *http.Response
	err      error
	request  []byte
}

func (d *stubDoer) Do(request *http.Request) (*http.Response, error) {
	if request.Body != nil {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		d.request = body
	}
	if d.err != nil {
		return nil, d.err
	}
	return d.response, nil
}

func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     http.Header{},
	}
}

func responsesPayload(species, reason string) string {
	inner, err := json.Marshal(map[string]string{"species": species, "reason": reason})
	if err != nil {
		panic(err)
	}
	outer, err := json.Marshal(map[string]any{"output_text": string(inner)})
	if err != nil {
		panic(err)
	}
	return string(outer)
}

func testAnimals() []availableAnimal {
	return []availableAnimal{
		{ID: "dog", LabelJA: "犬"},
		{ID: "cat", LabelJA: "猫"},
	}
}

func newTestAssociator(t *testing.T, doer httpDoer) *llmAssociator {
	t.Helper()
	associator, err := newLLMAssociator(doer, defaultAssociationEndpoint, "test-key", defaultAssociationModel)
	if err != nil {
		t.Fatal(err)
	}
	return associator
}

// 候補外の動物を返されると連想がまるごと失敗するため、候補idをenumとして送る。
func TestAssociationRequestConstrainsSpeciesToCandidates(t *testing.T) {
	doer := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayload("dog", "犬の話だから"))}
	associator := newTestAssociator(t, doer)
	if _, err := associator.Select(context.Background(), "犬が好きです", testAnimals()); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Text struct {
			Format struct {
				Schema struct {
					Properties struct {
						Species struct {
							Enum []string `json:"enum"`
						} `json:"species"`
					} `json:"properties"`
				} `json:"schema"`
			} `json:"format"`
		} `json:"text"`
	}
	if err := json.Unmarshal(doer.request, &payload); err != nil {
		t.Fatal(err)
	}
	got := payload.Text.Format.Schema.Properties.Species.Enum
	if len(got) != 2 || got[0] != "dog" || got[1] != "cat" {
		t.Fatalf("species enum = %v, want the candidate ids", got)
	}
}

// 理由が長すぎるとgateway側の検証で合成結果ごと捨てられるため、サービス側で丸める。
func TestAssociationTruncatesLongReason(t *testing.T) {
	long := strings.Repeat("あ", associationReasonMaxRunes+50)
	doer := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayload("cat", long))}
	associator := newTestAssociator(t, doer)
	selection, err := associator.Select(context.Background(), "猫の話", testAnimals())
	if err != nil {
		t.Fatal(err)
	}
	if runes := []rune(selection.Reason); len(runes) != associationReasonMaxRunes+1 {
		t.Fatalf("reason rune count = %d, want %d", len(runes), associationReasonMaxRunes+1)
	}
	if !strings.HasSuffix(selection.Reason, "…") {
		t.Fatalf("reason = %q, want a truncation mark at the end", selection.Reason)
	}
}

func TestAssociationErrorsAreClassifiedByRetryability(t *testing.T) {
	for _, test := range []struct {
		name         string
		doer         *stubDoer
		expectedCode string
	}{
		{
			name:         "network failure",
			doer:         &stubDoer{err: errors.New("dial tcp: timeout")},
			expectedCode: "association_unavailable",
		},
		{
			name:         "rate limited",
			doer:         &stubDoer{response: jsonResponse(http.StatusTooManyRequests, `{"error":"slow down"}`)},
			expectedCode: "association_unavailable",
		},
		{
			name:         "upstream outage",
			doer:         &stubDoer{response: jsonResponse(http.StatusBadGateway, `{"error":"bad gateway"}`)},
			expectedCode: "association_unavailable",
		},
		{
			name:         "empty output",
			doer:         &stubDoer{response: jsonResponse(http.StatusOK, `{"output_text":""}`)},
			expectedCode: "association_unavailable",
		},
		{
			name:         "empty reason",
			doer:         &stubDoer{response: jsonResponse(http.StatusOK, responsesPayload("dog", "  "))},
			expectedCode: "association_unavailable",
		},
		{
			name:         "unauthorized",
			doer:         &stubDoer{response: jsonResponse(http.StatusUnauthorized, `{"error":"bad key"}`)},
			expectedCode: "association_failed",
		},
		{
			name:         "unparsable output",
			doer:         &stubDoer{response: jsonResponse(http.StatusOK, `{"output_text":"not json"}`)},
			expectedCode: "association_failed",
		},
		{
			name:         "unknown species",
			doer:         &stubDoer{response: jsonResponse(http.StatusOK, responsesPayload("dragon", "空想上の動物"))},
			expectedCode: "association_failed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			associator := newTestAssociator(t, test.doer)
			_, err := associator.Select(context.Background(), "何かの話", testAnimals())
			var apiError *APIError
			if !errors.As(err, &apiError) {
				t.Fatalf("err = %v, want an *APIError", err)
			}
			if apiError.Code != test.expectedCode {
				t.Fatalf("code = %q, want %q", apiError.Code, test.expectedCode)
			}
		})
	}
}
