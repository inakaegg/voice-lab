package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

type assetVariant struct {
	Path   string
	Credit soundCredit
}

type availableAnimal struct {
	ID       string
	LabelJA  string
	Variants []assetVariant
}

// assetCatalog は音源カタログ。動物IDと鳴き声素材の対応だけを持ち、
// 連想の知識は持たない（連想はLLMが候補リストから選ぶ）。
type assetCatalog struct {
	Animals      []availableAnimal
	byID         map[string]availableAnimal
	creditByPath map[string]soundCredit
}

// 最終セットのmanifest（tmp1/final/manifest.json と同スキーマ）。
// 1動物に複数ファイルを持ち、ファイル単位でクレジットとSHA-256を持つ。
type soundsManifest struct {
	SchemaVersion int `json:"schema_version"`
	Animals       []struct {
		ID      string `json:"id"`
		LabelJA string `json:"label_ja"`
		Files   []struct {
			File      string `json:"file"`
			License   string `json:"license"`
			Creator   string `json:"creator"`
			SourceURL string `json:"source_url"`
			SHA256    string `json:"sha256"`
		} `json:"files"`
	} `json:"animals"`
}

// loadSoundsCatalog は manifest付き音源ディレクトリからカタログを作る。
// 各ファイルのSHA-256一致を必須にする。
func loadSoundsCatalog(soundsDir string) (*assetCatalog, error) {
	manifestPath := filepath.Join(soundsDir, "manifest.json")
	payload, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("read sounds manifest: %w", err)
	}
	var manifest soundsManifest
	if err := json.Unmarshal(payload, &manifest); err != nil {
		return nil, fmt.Errorf("parse sounds manifest %s: %w", manifestPath, err)
	}
	if manifest.SchemaVersion != 1 || len(manifest.Animals) == 0 {
		return nil, fmt.Errorf("sounds manifest %s is invalid", manifestPath)
	}
	animals := make([]availableAnimal, 0, len(manifest.Animals))
	for _, animal := range manifest.Animals {
		if len(animal.Files) == 0 {
			return nil, fmt.Errorf("sounds manifest %s has an entry without files", manifestPath)
		}
		if err := validateCatalogIdentity(animal.ID, animal.LabelJA); err != nil {
			return nil, fmt.Errorf("sounds manifest %s: %w", manifestPath, err)
		}
		variants := make([]assetVariant, 0, len(animal.Files))
		for _, file := range animal.Files {
			credit := soundCredit{License: file.License, Creator: file.Creator, SourceURL: file.SourceURL}
			if err := validateCatalogCredit(animal.ID, credit); err != nil {
				return nil, fmt.Errorf("sounds manifest %s: %w", manifestPath, err)
			}
			if licenseNeedsCredit(file.License) && (file.Creator == "" || file.SourceURL == "") {
				return nil, fmt.Errorf(
					"sounds manifest entry %q has a %q file without creator or source_url", animal.ID, file.License,
				)
			}
			path, err := verifiedAssetPath(soundsDir, animal.ID, file.File, file.SHA256)
			if err != nil {
				return nil, err
			}
			variants = append(variants, assetVariant{Path: path, Credit: credit})
		}
		animals = append(animals, availableAnimal{ID: animal.ID, LabelJA: animal.LabelJA, Variants: variants})
	}
	return newCatalog(animals), nil
}

// 次の上限とパターンは、Cloudflare Workerが動物一覧と合成結果に課している検査
// （isBoundedIdentifier / isBoundedString / isBoundedHttpsUrl）と同じ条件である。
// 上限はJavaScriptの String.length と同じUTF-16のcode unit数で数える。
// 値が食い違うと検査がすり抜けるので、TestCatalogLimitsMatchTheGatewayContract が
// Workerのソースと突き合わせる。
const (
	catalogIDMaxUnits         = 80
	catalogLabelMaxUnits      = 80
	catalogCreditTextMaxUnits = 200
	catalogSourceURLMaxUnits  = 500
)

var catalogIDPattern = regexp.MustCompile(`^[a-z0-9_-]{1,` + strconv.Itoa(catalogIDMaxUnits) + `}$`)

// validateCatalogIdentity は動物IDと表示名がgateway側の検査を通る形かを起動時に確かめる。
// 差し替え可能な音源ディレクトリに条件外のIDや長い表示名が入ると、Workerが一覧ごと
// 502で捨てたり、その動物が選ばれた回の合成結果だけを捨てたりする。
// 公開requestが壊れる前に、起動時点で落とす。
func validateCatalogIdentity(id, labelJA string) error {
	if !catalogIDPattern.MatchString(id) {
		return fmt.Errorf("entry id %q must match %s", id, catalogIDPattern)
	}
	if err := validateBoundedText(labelJA, catalogLabelMaxUnits); err != nil {
		return fmt.Errorf("entry %q label %w", id, err)
	}
	return nil
}

// validateCatalogCredit はクレジットがgateway側の検査（isValidSoundCredits）を通る形かを
// 起動時に確かめる。空でないが条件を外れたクレジットを載せると、その素材が選ばれた回の
// 合成結果だけをWorkerが捨てるため、利用者から見ると散発的な失敗になる。
func validateCatalogCredit(animalID string, credit soundCredit) error {
	if err := validateBoundedText(credit.License, catalogCreditTextMaxUnits); err != nil {
		return fmt.Errorf("entry %q license %w", animalID, err)
	}
	// 空の作者と配布ページはJSONから落とすので、gatewayでは未指定として通る。
	if credit.Creator != "" {
		if err := validateBoundedText(credit.Creator, catalogCreditTextMaxUnits); err != nil {
			return fmt.Errorf("entry %q creator %w", animalID, err)
		}
	}
	if credit.SourceURL != "" {
		if err := validateBoundedText(credit.SourceURL, catalogSourceURLMaxUnits); err != nil {
			return fmt.Errorf("entry %q source_url %w", animalID, err)
		}
		parsed, err := url.Parse(credit.SourceURL)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return fmt.Errorf("entry %q source_url %q must be an https URL", animalID, credit.SourceURL)
		}
	}
	return nil
}

// validateBoundedText はgatewayの isBoundedString と同じ条件を確かめる。
// 空白だけの値を空として扱い、長さはUTF-16のcode unit数で数える。
func validateBoundedText(value string, maxUnits int) error {
	if strings.TrimFunc(value, unicode.IsSpace) == "" {
		return fmt.Errorf("is blank")
	}
	if units := len(utf16.Encode([]rune(value))); units > maxUnits {
		return fmt.Errorf("is %d units long, limit is %d", units, maxUnits)
	}
	return nil
}

// licenseNeedsCredit は、そのライセンスが出典表示を条件にしているかを返す。
// CC0とpublic domainは表示義務が無いので作者と配布ページが空でよい。
// それ以外（CC BY・小森平の利用規約）は表示が利用条件なので、画面へ出す材料が
// 欠けたまま配信されないよう起動時に落とす。
func licenseNeedsCredit(license string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(license))
	return !strings.HasPrefix(normalized, "CC0") && !strings.HasPrefix(normalized, "PUBLIC DOMAIN")
}

// verifiedAssetPath は manifest記載の相対パスを検証し、SHA-256の一致を確かめる。
func verifiedAssetPath(soundsDir, animalID, file, expectedSHA string) (string, error) {
	relative := filepath.FromSlash(file)
	if filepath.IsAbs(relative) || strings.HasPrefix(relative, "..") || filepath.Clean(relative) != relative {
		return "", fmt.Errorf("sounds manifest entry %q has invalid file path %q", animalID, file)
	}
	path := filepath.Join(soundsDir, relative)
	if !regularFileExists(path) {
		return "", fmt.Errorf("animal %q audio is missing: %s", animalID, file)
	}
	actualSHA, err := fileSHA256(path)
	if err != nil {
		return "", fmt.Errorf("hash animal %q audio: %w", animalID, err)
	}
	if actualSHA != strings.ToLower(expectedSHA) {
		return "", fmt.Errorf("animal %q audio SHA-256 mismatch: %s", animalID, file)
	}
	return path, nil
}

func newCatalog(animals []availableAnimal) *assetCatalog {
	sort.Slice(animals, func(i, j int) bool { return animals[i].ID < animals[j].ID })
	catalog := &assetCatalog{
		Animals:      animals,
		byID:         make(map[string]availableAnimal, len(animals)),
		creditByPath: make(map[string]soundCredit),
	}
	for _, animal := range animals {
		catalog.byID[animal.ID] = animal
		for _, variant := range animal.Variants {
			catalog.creditByPath[variant.Path] = variant.Credit
		}
	}
	return catalog
}

// creditsForPaths は使用した素材パス群のクレジットを重複なしで返す。
func (catalog *assetCatalog) creditsForPaths(paths []string) []soundCredit {
	credits := make([]soundCredit, 0, len(paths))
	seen := make(map[soundCredit]bool, len(paths))
	for _, path := range paths {
		credit, found := catalog.creditByPath[path]
		if !found || seen[credit] {
			continue
		}
		seen[credit] = true
		credits = append(credits, credit)
	}
	return credits
}

func (catalog *assetCatalog) ids() []string {
	ids := make([]string, 0, len(catalog.Animals))
	for _, animal := range catalog.Animals {
		ids = append(ids, animal.ID)
	}
	return ids
}

func (catalog *assetCatalog) publicAnimals() []AnimalSummary {
	summaries := make([]AnimalSummary, 0, len(catalog.Animals))
	for _, animal := range catalog.Animals {
		summaries = append(summaries, AnimalSummary{
			ID: animal.ID, LabelJA: animal.LabelJA, Variants: len(animal.Variants),
		})
	}
	return summaries
}

func directoryExists(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func regularFileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
