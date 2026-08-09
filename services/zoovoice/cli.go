package main

import (
	"context"
	"encoding/base64"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// preview は機能確認用のCLI。入力テキストまたは入力音声から、
// 連想された動物・採用した鳴き声素材とそのクレジット・合成結果を表示する。
// サーバと同じ catalog / associator / transcriber / composer を使う。
func runPreviewCLI(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("preview", flag.ContinueOnError)
	flags.SetOutput(stderr)
	textInput := flags.String("text", "", "入力テキスト（連想と素材の確認だけを行う）")
	audioInput := flags.String("audio", "", "入力音声ファイル（ASRから合成まで通す）")
	outputPath := flags.String("out", "zoovoice-preview.wav", "合成音声の出力先（-audio のとき）")
	intensity := flags.Int("intensity", 50, "アニマル度（0〜100）")
	verbose := flags.Bool("verbose", false, "処理ログを標準エラーへ出す")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	if (*textInput == "") == (*audioInput == "") {
		fmt.Fprintln(stderr, "usage: zoovoice preview (-text <入力テキスト> | -audio <音声ファイル>) [-out 出力.wav] [-intensity 0-100] [-verbose]")
		return 2
	}
	if err := runPreview(*textInput, *audioInput, *outputPath, *intensity, *verbose, stdout, stderr); err != nil {
		fmt.Fprintf(stderr, "preview failed: %v\n", err)
		return 1
	}
	return 0
}

func runPreview(textInput, audioInput, outputPath string, intensity int, verbose bool, stdout, stderr io.Writer) error {
	assetsRoot := defaultAssetsRoot()
	catalog, err := loadRuntimeCatalog(assetsRoot)
	if err != nil {
		return err
	}
	associator, store, err := loadAssociatorFromEnv(execCommandRunner{}, filepath.Join(assetsRoot, "animal-lexicon.json"))
	if err != nil {
		return err
	}
	defer store.Close()

	fmt.Fprintf(stdout, "動物カタログ: %d種\n", len(catalog.Animals))
	if len(catalog.UnusedSoundAnimals) > 0 {
		fmt.Fprintf(
			stdout,
			"注: 音源はあるが連想語彙が未整備のため選ばれない動物が%d種あります: %s\n",
			len(catalog.UnusedSoundAnimals),
			strings.Join(catalog.UnusedSoundAnimals, ", "),
		)
	}

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	ctx := context.Background()
	if textInput != "" {
		return previewText(ctx, textInput, catalog, associator, rng, stdout)
	}
	return previewAudio(ctx, audioInput, outputPath, intensity, verbose, catalog, associator, rng, stdout, stderr)
}

func previewText(
	ctx context.Context,
	textInput string,
	catalog *assetCatalog,
	associator animalAssociator,
	rng *rand.Rand,
	stdout io.Writer,
) error {
	selection, err := associator.Select(ctx, textInput, catalog.Animals, rng)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "\n入力テキスト: %s\n", textInput)
	printSelection(stdout, selection)
	fmt.Fprintln(stdout, "\n鳴き声素材:")
	for _, variant := range catalog.byID[selection.Species].Variants {
		fmt.Fprintf(stdout, "  %s\n    クレジット: %s\n", variant.Path, variant.Credit.Line())
	}
	return nil
}

func previewAudio(
	ctx context.Context,
	audioInput, outputPath string,
	intensity int,
	verbose bool,
	catalog *assetCatalog,
	associator animalAssociator,
	rng *rand.Rand,
	stdout, stderr io.Writer,
) error {
	activeTranscriber, err := loadTranscriberFromEnv(execCommandRunner{})
	if err != nil {
		return fmt.Errorf("音声入力にはASR(whisper)の設定が要ります: %w", err)
	}
	audio, err := os.ReadFile(audioInput)
	if err != nil {
		return err
	}
	logger := log.New(io.Discard, "", 0)
	if verbose {
		logger = log.New(stderr, "", 0)
	}
	activeComposer := newComposer(
		catalog,
		execCommandRunner{},
		activeTranscriber,
		associator,
		rng,
		durationFromEnv("ZOOVOICE_TIMEOUT_SECONDS", defaultComposeTimeout),
		logger,
	)
	fmt.Fprintf(stdout, "\n入力音声: %s（処理中。ASRに数十秒かかることがあります）\n", audioInput)
	result, err := activeComposer.Compose(ctx, audio, ComposeSettings{Intensity: intensity})
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "文字起こし: %s\n", result.Transcript)
	printSelection(stdout, AnimalSelection{
		Species:        result.SelectedAnimal.ID,
		LabelJA:        result.SelectedAnimal.LabelJA,
		EvidenceTerm:   stringValue(result.EvidenceTerm),
		Strategy:       result.SelectionStrategy,
		FallbackReason: stringValue(result.FallbackReason),
	})
	fmt.Fprintln(stdout, "\n使った鳴き声素材:")
	printedPaths := map[string]bool{}
	for _, insertion := range result.Insertions {
		if printedPaths[insertion.AssetPath] {
			continue
		}
		printedPaths[insertion.AssetPath] = true
		fmt.Fprintf(stdout, "  %s\n", insertion.AssetPath)
	}
	for _, credit := range result.SoundCredits {
		fmt.Fprintf(stdout, "  クレジット: %s\n", credit.Line())
	}
	fmt.Fprintln(stdout, "\n挿入位置:")
	for _, insertion := range result.Insertions {
		fmt.Fprintf(stdout, "  %-7s %.2f秒\n", insertion.Slot, insertion.AtSeconds)
	}
	payload, err := base64.StdEncoding.DecodeString(result.AudioBase64)
	if err != nil {
		return fmt.Errorf("decode composed audio: %w", err)
	}
	if err := os.WriteFile(outputPath, payload, 0o644); err != nil {
		return fmt.Errorf("write composed audio: %w", err)
	}
	fmt.Fprintf(
		stdout,
		"\n合成音声: %s（入力%.1f秒 → 出力%.1f秒）\nafplay等で再生して確認できます。\n",
		outputPath,
		result.InputDurationSeconds,
		result.OutputDurationSeconds,
	)
	return nil
}

func printSelection(stdout io.Writer, selection AnimalSelection) {
	fmt.Fprintf(stdout, "連想した動物: %s（%s）\n", selection.LabelJA, selection.Species)
	fmt.Fprintf(stdout, "決まった経路: %s（%s）\n", selection.Strategy, strategyExplanation(selection.Strategy))
	if selection.EvidenceTerm != "" {
		fmt.Fprintf(stdout, "根拠語: %s\n", selection.EvidenceTerm)
	}
	if selection.FallbackReason != "" {
		fmt.Fprintf(stdout, "fallback理由: %s\n", selection.FallbackReason)
	}
	if selection.Score != nil && len(selection.Score.Contributions) > 0 {
		fmt.Fprintln(stdout, "連想の内訳（スコア上位）:")
		for index, contribution := range selection.Score.Contributions {
			if index >= 3 {
				break
			}
			fmt.Fprintf(
				stdout,
				"  概念「%s」 %s 重み%.2f×%.2f=%.2f\n",
				contribution.Concept,
				contribution.Relation,
				contribution.Weight,
				contribution.Multiplier,
				contribution.Weighted,
			)
		}
	}
}

func strategyExplanation(strategy SelectionStrategy) string {
	switch strategy {
	case strategyDirect:
		return "発話の語が動物の語彙と直接一致"
	case strategyPun:
		return "別の語句と重なる語呂合わせで一致"
	case strategyConceptNet:
		return "ConceptNetの連想で関係の重み合計が最大"
	case strategyEmbedding:
		return "意味ベクトルによる連想"
	case strategyRandom:
		return "一致が無かったため利用可能な動物からランダム選択"
	}
	return string(strategy)
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
