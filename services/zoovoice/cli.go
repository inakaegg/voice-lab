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
	associator, err := loadAssociatorFromEnv()
	if err != nil {
		return err
	}

	fmt.Fprintf(stdout, "動物カタログ: %d種（すべて連想の候補になります）\n", len(catalog.Animals))

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	ctx := context.Background()
	if textInput != "" {
		return previewText(ctx, textInput, catalog, associator, stdout)
	}
	return previewAudio(ctx, audioInput, outputPath, intensity, verbose, catalog, associator, rng, stdout, stderr)
}

func previewText(
	ctx context.Context,
	textInput string,
	catalog *assetCatalog,
	associator animalAssociator,
	stdout io.Writer,
) error {
	selection, err := associator.Select(ctx, textInput, catalog.Animals)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "\n入力テキスト: %s\n", textInput)
	printSelection(stdout, selection.LabelJA, selection.Species, selection.Reason)
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
	printSelection(stdout, result.SelectedAnimal.LabelJA, result.SelectedAnimal.ID, result.AssociationReason)
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

func printSelection(stdout io.Writer, labelJA, species, reason string) {
	fmt.Fprintf(stdout, "連想した動物: %s（%s）\n", labelJA, species)
	if reason != "" {
		fmt.Fprintf(stdout, "連想の理由: %s\n", reason)
	}
}
