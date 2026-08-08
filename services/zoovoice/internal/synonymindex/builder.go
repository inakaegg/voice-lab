package synonymindex

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type BuildOptions struct {
	SourcePath   string
	SourceSHA256 string
	OutputPath   string
	// MinLemmaLength より短い見出し語は捨てる。日本語は「喉」「犬」「雨」のように
	// 1文字語が正当な見出し語になるため、既定では除外しない。
	MinLemmaLength int
}

type lexicalEntry struct {
	ID    string `xml:"id,attr"`
	Lemma struct {
		WrittenForm  string `xml:"writtenForm,attr"`
		PartOfSpeech string `xml:"partOfSpeech,attr"`
	} `xml:"Lemma"`
	Forms []struct {
		WrittenForm string `xml:"writtenForm,attr"`
	} `xml:"Form"`
	Senses []struct {
		Synset string `xml:"synset,attr"`
	} `xml:"Sense"`
}

type entryRef struct {
	ID           string
	Lemma        string
	Spellings    []string
	PartOfSpeech string
}

// Build はJapanese WordNetのXMLを読み、同じsynsetを共有する見出し語の組をSQLiteへ書く。
func Build(ctx context.Context, options BuildOptions) error {
	if strings.TrimSpace(options.SourceSHA256) == "" {
		return fmt.Errorf("source SHA-256 must not be empty")
	}
	minLength := options.MinLemmaLength
	if minLength < 1 {
		minLength = 1
	}

	file, err := os.Open(options.SourcePath)
	if err != nil {
		return fmt.Errorf("open WordNet source: %w", err)
	}
	defer file.Close()

	synsetMembers := make(map[string][]entryRef)
	decoder := xml.NewDecoder(file)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("parse WordNet source: %w", err)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "LexicalEntry" {
			continue
		}
		var entry lexicalEntry
		if err := decoder.DecodeElement(&entry, &start); err != nil {
			return fmt.Errorf("decode lexical entry: %w", err)
		}
		lemma := normalizeTerm(entry.Lemma.WrittenForm)
		spellings := []string{lemma}
		for _, form := range entry.Forms {
			spellings = append(spellings, normalizeTerm(form.WrittenForm))
		}
		spellings = cleanedSpellings(spellings, minLength)
		if lemma == "" || len(spellings) == 0 {
			continue
		}
		reference := entryRef{
			ID:           strings.TrimSpace(entry.ID),
			Lemma:        lemma,
			Spellings:    spellings,
			PartOfSpeech: entry.Lemma.PartOfSpeech,
		}
		for _, sense := range entry.Senses {
			synset := strings.TrimSpace(sense.Synset)
			if synset == "" {
				continue
			}
			synsetMembers[synset] = append(synsetMembers[synset], reference)
		}
	}

	if err := os.Remove(options.OutputPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove existing index: %w", err)
	}
	db, err := sql.Open("sqlite", options.OutputPath)
	if err != nil {
		return fmt.Errorf("create synonym index: %w", err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("apply synonym index schema: %w", err)
	}

	transaction, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin synonym transaction: %w", err)
	}
	statement, err := transaction.PrepareContext(
		ctx,
		`INSERT OR IGNORE INTO synonyms(term, synonym, part_of_speech, synset) VALUES(?, ?, ?, ?)`,
	)
	if err != nil {
		transaction.Rollback()
		return fmt.Errorf("prepare synonym insert: %w", err)
	}

	synsets := make([]string, 0, len(synsetMembers))
	for synset := range synsetMembers {
		synsets = append(synsets, synset)
	}
	sort.Strings(synsets)

	pairCount := 0
	for _, synset := range synsets {
		members := dedupeEntries(synsetMembers[synset])
		if len(members) < 2 {
			continue
		}
		for _, source := range members {
			for _, term := range source.Spellings {
				for _, target := range members {
					if source.key() == target.key() || term == target.Lemma {
						continue
					}
					result, err := statement.ExecContext(
						ctx, term, target.Lemma, target.PartOfSpeech, synset,
					)
					if err != nil {
						statement.Close()
						transaction.Rollback()
						return fmt.Errorf("write synonym pair: %w", err)
					}
					inserted, err := result.RowsAffected()
					if err != nil {
						statement.Close()
						transaction.Rollback()
						return fmt.Errorf("count synonym pair: %w", err)
					}
					pairCount += int(inserted)
				}
			}
		}
	}
	statement.Close()

	metadata := map[string]string{
		"schema_version": SchemaVersion,
		"source_sha256":  strings.ToLower(options.SourceSHA256),
		"transformation": transformationDescription,
		"generated_at":   time.Now().UTC().Format(time.RFC3339),
		"pair_count":     fmt.Sprintf("%d", pairCount),
	}
	for key, value := range metadata {
		if _, err := transaction.ExecContext(
			ctx, `INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)`, key, value,
		); err != nil {
			transaction.Rollback()
			return fmt.Errorf("write metadata %s: %w", key, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("commit synonym index: %w", err)
	}
	return nil
}

func cleanedSpellings(values []string, minLength int) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = normalizeTerm(value)
		if len([]rune(value)) < minLength {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func (entry entryRef) key() string {
	if entry.ID != "" {
		return entry.ID
	}
	return entry.Lemma + "\x00" + entry.PartOfSpeech
}

func dedupeEntries(members []entryRef) []entryRef {
	seen := make(map[string]struct{}, len(members))
	unique := make([]entryRef, 0, len(members))
	for _, member := range members {
		key := member.key()
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, member)
	}
	sort.Slice(unique, func(i, j int) bool { return unique[i].key() < unique[j].key() })
	return unique
}

func normalizeTerm(term string) string {
	return strings.TrimSpace(strings.ReplaceAll(term, "_", " "))
}

func FileSHA256(path string) (string, error) {
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
