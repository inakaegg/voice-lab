package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
)

// strategyEmbedding は、Embedding runnerが選んだ動物であることを表す。
const strategyEmbedding SelectionStrategy = "embedding_profile"

type embeddingCandidate struct {
	Rank    int     `json:"rank"`
	ID      string  `json:"id"`
	LabelJA string  `json:"label_ja"`
	Score   float64 `json:"score"`
}

type embeddingRunnerResponse struct {
	Candidates []embeddingCandidate `json:"candidates"`
	Error      *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// embeddingAssociator は、ONNX embedding runnerをsubprocessとして呼び、動物を選ぶ。
// whisper-cliと同じく1リクエスト1プロセスで起動し、常駐させない。
type embeddingAssociator struct {
	runner        commandRunner
	pythonPath    string
	scriptPath    string
	modelPath     string
	artifactsPath string
	threads       int
}

func newEmbeddingAssociator(
	runner commandRunner,
	pythonPath string,
	scriptPath string,
	modelPath string,
	artifactsPath string,
	threads int,
) (*embeddingAssociator, error) {
	if strings.TrimSpace(pythonPath) == "" {
		return nil, fmt.Errorf("ZOOVOICE_EMBEDDING_PYTHON must not be empty")
	}
	if strings.TrimSpace(scriptPath) == "" {
		return nil, fmt.Errorf("ZOOVOICE_EMBEDDING_RUNNER must not be empty")
	}
	if strings.TrimSpace(modelPath) == "" {
		return nil, fmt.Errorf("ZOOVOICE_EMBEDDING_MODEL_DIR must not be empty")
	}
	if strings.TrimSpace(artifactsPath) == "" {
		return nil, fmt.Errorf("ZOOVOICE_EMBEDDING_ARTIFACTS_DIR must not be empty")
	}
	if threads < 1 {
		return nil, fmt.Errorf("embedding threads must be positive")
	}
	return &embeddingAssociator{
		runner:        runner,
		pythonPath:    pythonPath,
		scriptPath:    scriptPath,
		modelPath:     modelPath,
		artifactsPath: artifactsPath,
		threads:       threads,
	}, nil
}

func (associator *embeddingAssociator) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
	rng *rand.Rand,
) (AnimalSelection, error) {
	if len(animals) == 0 {
		return AnimalSelection{}, fmt.Errorf("no animal assets are available")
	}
	output, err := associator.runner.Run(
		ctx,
		associator.pythonPath,
		associator.scriptPath,
		"associate",
		"--model", associator.modelPath,
		"--artifacts", associator.artifactsPath,
		"--text", transcript,
		"--top-k", strconv.Itoa(len(animals)),
		"--threads", strconv.Itoa(associator.threads),
	)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return AnimalSelection{}, ctxErr
		}
		return AnimalSelection{}, fmt.Errorf(
			"embedding runner failed: %w: %s", err, strings.TrimSpace(output.Stderr),
		)
	}

	var response embeddingRunnerResponse
	if err := json.Unmarshal([]byte(output.Stdout), &response); err != nil {
		return AnimalSelection{}, fmt.Errorf("decode embedding runner output: %w", err)
	}
	if response.Error != nil {
		return AnimalSelection{}, fmt.Errorf(
			"embedding runner reported %s: %s", response.Error.Code, response.Error.Message,
		)
	}

	// 音源を持つ動物だけを採用する。runnerは全動物を返すため、ここで突き合わせる。
	available := make(map[string]availableAnimal, len(animals))
	for _, animal := range animals {
		available[animal.ID] = animal
	}
	for _, candidate := range response.Candidates {
		animal, ok := available[candidate.ID]
		if !ok {
			continue
		}
		score := candidate.Score
		return AnimalSelection{
			Species:      animal.ID,
			LabelJA:      animal.LabelJA,
			EvidenceTerm: transcript,
			Strategy:     strategyEmbedding,
			Score:        &SelectionScore{Total: score, Contributions: []ScoreContribution{}},
		}, nil
	}

	fallback := animals[rng.Intn(len(animals))]
	return AnimalSelection{
		Species:        fallback.ID,
		LabelJA:        fallback.LabelJA,
		Strategy:       strategyRandom,
		FallbackReason: "no_available_embedding_candidate",
	}, nil
}

// embeddingFallbackAssociator は、辞書エンジンが連想できなかったときだけembeddingを試す。
// embeddingの失敗はサービス失敗にせず、辞書側のランダム選択を維持する。
type embeddingFallbackAssociator struct {
	primary   animalAssociator
	embedding animalAssociator
}

func (associator *embeddingFallbackAssociator) Select(
	ctx context.Context,
	transcript string,
	animals []availableAnimal,
	rng *rand.Rand,
) (AnimalSelection, error) {
	selection, err := associator.primary.Select(ctx, transcript, animals, rng)
	if err != nil || selection.Strategy != strategyRandom {
		return selection, err
	}
	embedded, embedErr := associator.embedding.Select(ctx, transcript, animals, rng)
	if embedErr != nil || embedded.Strategy != strategyEmbedding {
		return selection, nil
	}
	return embedded, nil
}

var embeddingEnvNames = []string{
	"ZOOVOICE_EMBEDDING_PYTHON",
	"ZOOVOICE_EMBEDDING_RUNNER",
	"ZOOVOICE_EMBEDDING_MODEL_DIR",
	"ZOOVOICE_EMBEDDING_ARTIFACTS_DIR",
}

// embeddingAssociatorFromEnv は、環境変数4つがそろったときだけassociatorを返す。
// 全て未設定ならnilを返し、一部だけの設定は設定ミスとしてエラーにする。
func embeddingAssociatorFromEnv(runner commandRunner) (animalAssociator, error) {
	values := make(map[string]string, len(embeddingEnvNames))
	configured := 0
	for _, name := range embeddingEnvNames {
		value := strings.TrimSpace(os.Getenv(name))
		values[name] = value
		if value != "" {
			configured++
		}
	}
	if configured == 0 {
		return nil, nil
	}
	if configured != len(embeddingEnvNames) {
		return nil, fmt.Errorf(
			"embedding requires all of %s to be set", strings.Join(embeddingEnvNames, ", "),
		)
	}
	threads, err := positiveIntegerEnv("ZOOVOICE_EMBEDDING_THREADS", 2)
	if err != nil {
		return nil, err
	}
	return newEmbeddingAssociator(
		runner,
		values["ZOOVOICE_EMBEDDING_PYTHON"],
		values["ZOOVOICE_EMBEDDING_RUNNER"],
		values["ZOOVOICE_EMBEDDING_MODEL_DIR"],
		values["ZOOVOICE_EMBEDDING_ARTIFACTS_DIR"],
		threads,
	)
}
