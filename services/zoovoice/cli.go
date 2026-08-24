package main

import (
	"context"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"os"
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
	animals := flags.Int("animals", defaultAnimalCount, "連想する動物の種類数（1か2）")
	speciesInput := flags.String("species", "", "LLMを使わず固定する動物種ID（1件かカンマ区切りの2件）")
	verbose := flags.Bool("verbose", false, "処理ログを標準エラーへ出す")
	if err := flags.Parse(arguments); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if (*textInput == "") == (*audioInput == "") {
		fmt.Fprintln(stderr, "usage: zoovoice preview (-text <入力テキスト> | -audio <音声ファイル>) [-out 出力.wav] [-intensity 0-100] [-animals 1|2 | -species id[,id]] [-verbose]")
		return 2
	}
	if err := validateIntensity(*intensity); err != nil {
		fmt.Fprintln(stderr, "-intensity は0から100で指定してください")
		return 2
	}
	animalsExplicit := false
	speciesExplicit := false
	flags.Visit(func(option *flag.Flag) {
		switch option.Name {
		case "animals":
			animalsExplicit = true
		case "species":
			speciesExplicit = true
		}
	})
	if speciesExplicit && strings.TrimSpace(*speciesInput) == "" {
		fmt.Fprintln(stderr, "-species には1件または2件の動物種IDを指定してください")
		return 2
	}
	fixedSpecies, err := parseFixedSpecies(*speciesInput)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if len(fixedSpecies) > 0 && animalsExplicit {
		fmt.Fprintln(stderr, "-animals と -species は同時に指定できません")
		return 2
	}
	if len(fixedSpecies) > 0 {
		*animals = len(fixedSpecies)
	}
	if err := validateAnimalCount(*animals); err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	if err := runPreview(
		*textInput, *audioInput, *outputPath, *intensity, *animals, fixedSpecies, *verbose, stdout, stderr,
	); err != nil {
		var usageError *previewUsageError
		if errors.As(err, &usageError) {
			fmt.Fprintln(stderr, usageError)
			return 2
		}
		fmt.Fprintf(stderr, "preview failed: %v\n", err)
		return 1
	}
	return 0
}

func runPreview(
	textInput, audioInput, outputPath string,
	intensity, animals int,
	fixedSpecies []string,
	verbose bool,
	stdout, stderr io.Writer,
) error {
	catalog, err := loadRuntimeCatalog()
	if err != nil {
		return err
	}
	associator, err := loadPreviewAssociator(catalog, fixedSpecies)
	if err != nil {
		return err
	}
	segmenter, err := newKagomeSegmenter()
	if err != nil {
		return err
	}

	fmt.Fprintf(stdout, "動物カタログ: %d種（すべて連想の候補になります）\n", len(catalog.Animals))

	rng := rand.New(rand.NewSource(time.Now().UnixNano()))
	ctx := context.Background()
	if textInput != "" {
		return previewText(ctx, textInput, catalog, segmenter, associator, animals, stdout)
	}
	return previewAudio(
		ctx, audioInput, outputPath, intensity, animals, verbose,
		catalog, segmenter, associator, rng, stdout, stderr,
	)
}

// parseFixedSpecies はCLIのカンマ区切り指定を1件または2件の種IDへ直す。
// IDが音源カタログに存在するかは、カタログ読込み後にloadPreviewAssociatorで検査する。
func parseFixedSpecies(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	parts := strings.Split(value, ",")
	if len(parts) < 1 || len(parts) > maxAnimalCount {
		return nil, fmt.Errorf("-species には1件または2件の動物種IDを指定してください")
	}
	result := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		species := strings.TrimSpace(part)
		if species == "" {
			return nil, fmt.Errorf("-species には1件または2件の動物種IDを指定してください")
		}
		if seen[species] {
			return nil, fmt.Errorf("-species の動物種IDは重複できません: %s", species)
		}
		seen[species] = true
		result = append(result, species)
	}
	return result, nil
}

type fixedAnimalAssociator struct {
	selections []AnimalSelection
}

type previewUsageError struct {
	message string
}

func (err *previewUsageError) Error() string {
	return err.message
}

func loadPreviewAssociator(catalog *assetCatalog, species []string) (animalAssociator, error) {
	if len(species) == 0 {
		return loadAssociatorFromEnv()
	}
	selections := make([]AnimalSelection, 0, len(species))
	for _, id := range species {
		animal, known := catalog.byID[id]
		if !known {
			return nil, &previewUsageError{
				message: fmt.Sprintf("-species の動物種IDが音源カタログにありません: %s", id),
			}
		}
		selections = append(selections, AnimalSelection{
			Species:  animal.ID,
			LabelJA:  animal.LabelJA,
			Reason:   "CLIの -species で指定",
			Strategy: strategyFixedCLI,
		})
	}
	return fixedAnimalAssociator{selections: selections}, nil
}

func (associator fixedAnimalAssociator) Select(
	_ context.Context,
	_ string,
	_ []availableAnimal,
	_ int,
) ([]AnimalSelection, error) {
	return append([]AnimalSelection(nil), associator.selections...), nil
}

func previewText(
	ctx context.Context,
	textInput string,
	catalog *assetCatalog,
	segmenter wordSegmenter,
	associator animalAssociator,
	animals int,
	stdout io.Writer,
) error {
	selections, err := associator.Select(ctx, textInput, catalog.Animals, animals)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "\n入力テキスト: %s\n", textInput)
	printWords(stdout, segmenter.SplitWords(textInput))
	for _, selection := range selections {
		printSelection(stdout, selection.LabelJA, selection.Species, selection.Reason)
	}
	fmt.Fprintln(stdout, "\n鳴き声素材:")
	for _, selection := range selections {
		for _, variant := range catalog.byID[selection.Species].Variants {
			fmt.Fprintf(stdout, "  %s\n    クレジット: %s\n", variant.Path, variant.Credit.Line())
		}
	}
	return nil
}

func previewAudio(
	ctx context.Context,
	audioInput, outputPath string,
	intensity int,
	animals int,
	verbose bool,
	catalog *assetCatalog,
	segmenter wordSegmenter,
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
		segmenter,
		associator,
		rng,
		durationFromEnv("ZOOVOICE_TIMEOUT_SECONDS", defaultComposeTimeout),
		logger,
	)
	fmt.Fprintf(stdout, "\n入力音声: %s（処理中。ASRに数十秒かかることがあります）\n", audioInput)
	result, err := activeComposer.Compose(
		ctx, audio, ComposeSettings{Intensity: intensity, AnimalCount: animals},
	)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "文字起こし: %s\n", result.Transcript)
	printWords(stdout, result.Words)
	for _, choice := range result.SelectedAnimals {
		printSelection(stdout, choice.LabelJA, choice.ID, choice.Reason)
	}
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
		fmt.Fprintf(
			stdout,
			"  %-6s %6.2f秒  長さ%.2f秒  %s\n",
			insertion.Slot,
			insertion.AtSeconds,
			insertion.DurationSeconds,
			insertion.Species,
		)
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

// printWords は形態素分割の結果を出す。鳴き声はこの切れ目にだけ入るため、
// 分割そのものを目で確かめられるようにしている。
func printWords(stdout io.Writer, words []string) {
	if len(words) == 0 {
		return
	}
	fmt.Fprintf(stdout, "単語分割: %s\n", strings.Join(words, " | "))
}

func printSelection(stdout io.Writer, labelJA, species, reason string) {
	fmt.Fprintf(stdout, "連想した動物: %s（%s）\n", labelJA, species)
	if reason != "" {
		fmt.Fprintf(stdout, "連想の理由: %s\n", reason)
	}
}
