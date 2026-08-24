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
	return responsesPayloadFor([]map[string]string{{"species": species, "reason": reason}})
}

func responsesPayloadFor(animals []map[string]string) string {
	inner, err := json.Marshal(map[string]any{"animals": animals})
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
	if _, err := associator.Select(context.Background(), "犬が好きです", testAnimals(), 1); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Text struct {
			Format struct {
				Schema struct {
					Properties struct {
						Animals struct {
							Items struct {
								Properties struct {
									Species struct {
										Enum []string `json:"enum"`
									} `json:"species"`
								} `json:"properties"`
							} `json:"items"`
						} `json:"animals"`
					} `json:"properties"`
				} `json:"schema"`
			} `json:"format"`
		} `json:"text"`
	}
	if err := json.Unmarshal(doer.request, &payload); err != nil {
		t.Fatal(err)
	}
	got := payload.Text.Format.Schema.Properties.Animals.Items.Properties.Species.Enum
	if len(got) != 2 || got[0] != "dog" || got[1] != "cat" {
		t.Fatalf("species enum = %v, want the candidate ids", got)
	}
}

// 理由が長すぎるとgateway側の検証で合成結果ごと捨てられるため、サービス側で丸める。
func TestAssociationTruncatesLongReason(t *testing.T) {
	long := strings.Repeat("あ", associationReasonMaxRunes+50)
	doer := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayload("cat", long))}
	associator := newTestAssociator(t, doer)
	selections, err := associator.Select(context.Background(), "猫の話", testAnimals(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if runes := []rune(selections[0].Reason); len(runes) != associationReasonMaxRunes+1 {
		t.Fatalf("reason rune count = %d, want %d", len(runes), associationReasonMaxRunes+1)
	}
	if !strings.HasSuffix(selections[0].Reason, "…") {
		t.Fatalf("reason = %q, want a truncation mark at the end", selections[0].Reason)
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
		{
			name:         "no animals",
			doer:         &stubDoer{response: jsonResponse(http.StatusOK, responsesPayloadFor(nil))},
			expectedCode: "association_failed",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			associator := newTestAssociator(t, test.doer)
			_, err := associator.Select(context.Background(), "何かの話", testAnimals(), 1)
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

// 2種を頼んだときの挙動。件数はプロンプトへ渡し、schemaのminItems/maxItemsには頼らない。
func TestAssociationReturnsTwoSpeciesAndDeduplicates(t *testing.T) {
	doer := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayloadFor([]map[string]string{
		{"species": "dog", "reason": "犬の話だから"},
		{"species": "cat", "reason": "猫も出てくるから"},
	}))}
	associator := newTestAssociator(t, doer)
	selections, err := associator.Select(context.Background(), "犬と猫の話", testAnimals(), 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections) != 2 || selections[0].Species != "dog" || selections[1].Species != "cat" {
		t.Fatalf("selections = %#v", selections)
	}

	// 同じ動物を重ねて返されたら1件へ潰す。エラーにはしない。
	duplicated := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayloadFor([]map[string]string{
		{"species": "dog", "reason": "犬の話だから"},
		{"species": "dog", "reason": "やはり犬だから"},
	}))}
	selections, err = newTestAssociator(t, duplicated).Select(
		context.Background(), "犬の話", testAnimals(), 2,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections) != 1 || selections[0].Species != "dog" {
		t.Fatalf("selections = %#v", selections)
	}

	// 頼んだ数より多く返されたら先頭から必要な数だけ使う。
	extra := &stubDoer{response: jsonResponse(http.StatusOK, responsesPayloadFor([]map[string]string{
		{"species": "dog", "reason": "1件目"},
		{"species": "cat", "reason": "2件目"},
	}))}
	selections, err = newTestAssociator(t, extra).Select(context.Background(), "話", testAnimals(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(selections) != 1 || selections[0].Species != "dog" {
		t.Fatalf("selections = %#v", selections)
	}
}

// プロンプトには要求した種類数が入る。
func TestAssociationInstructionsCarryTheRequestedCount(t *testing.T) {
	if !strings.Contains(associationInstructions(2), "2種") {
		t.Fatalf("instructions = %q", associationInstructions(2))
	}
	if strings.Contains(associationInstructions(1), "同じ動物を重ねて") {
		t.Fatalf("instructions = %q", associationInstructions(1))
	}
	if !strings.Contains(associationInstructions(2), "同じ動物を重ねて") {
		t.Fatalf("instructions = %q", associationInstructions(2))
	}
}
