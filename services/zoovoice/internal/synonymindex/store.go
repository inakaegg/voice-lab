package synonymindex

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// Synonym は、ある語と同じsynsetに属する別の語である。
type Synonym struct {
	Term         string
	Synonym      string
	PartOfSpeech string
	Synset       string
}

type Store struct {
	db *sql.DB
}

func Open(path, expectedSourceSHA string) (*Store, error) {
	databaseURL := (&url.URL{
		Scheme:   "file",
		Path:     path,
		RawQuery: "mode=ro&immutable=1",
	}).String()
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open synonym index: %w", err)
	}
	metadata, err := readMetadata(context.Background(), db)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("read synonym index metadata: %w", err)
	}
	if metadata["schema_version"] != SchemaVersion {
		db.Close()
		return nil, fmt.Errorf("synonym index schema mismatch")
	}
	if !strings.EqualFold(metadata["source_sha256"], expectedSourceSHA) {
		db.Close()
		return nil, fmt.Errorf("synonym index source mismatch")
	}
	if strings.TrimSpace(metadata["generated_at"]) == "" {
		db.Close()
		return nil, fmt.Errorf("synonym index is incomplete")
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping synonym index: %w", err)
	}
	return &Store{db: db}, nil
}

// Synonyms は、与えた語と同じsynsetを共有する語を返す。問い合わせ語自身は含まない。
func (store *Store) Synonyms(ctx context.Context, terms []string) ([]Synonym, error) {
	unique := make([]string, 0, len(terms))
	seen := make(map[string]struct{}, len(terms))
	for _, term := range terms {
		term = normalizeTerm(term)
		if term == "" {
			continue
		}
		if _, exists := seen[term]; exists {
			continue
		}
		seen[term] = struct{}{}
		unique = append(unique, term)
	}
	if len(unique) == 0 {
		return []Synonym{}, nil
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
	arguments := make([]any, 0, len(unique))
	for _, term := range unique {
		arguments = append(arguments, term)
	}
	rows, err := store.db.QueryContext(
		ctx,
		`SELECT term, synonym, part_of_speech, synset FROM synonyms WHERE term IN (`+placeholders+`)`,
		arguments...,
	)
	if err != nil {
		return nil, fmt.Errorf("query synonyms: %w", err)
	}
	defer rows.Close()

	results := make([]Synonym, 0)
	for rows.Next() {
		var synonym Synonym
		if err := rows.Scan(
			&synonym.Term, &synonym.Synonym, &synonym.PartOfSpeech, &synonym.Synset,
		); err != nil {
			return nil, fmt.Errorf("scan synonym: %w", err)
		}
		results = append(results, synonym)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read synonyms: %w", err)
	}
	sort.Slice(results, func(i, j int) bool {
		if results[i].Term != results[j].Term {
			return results[i].Term < results[j].Term
		}
		return results[i].Synonym < results[j].Synonym
	})
	return results, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func readMetadata(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT key, value FROM metadata`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	metadata := make(map[string]string)
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		metadata[key] = value
	}
	return metadata, rows.Err()
}
