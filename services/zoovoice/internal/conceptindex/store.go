package conceptindex

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

type Edge struct {
	Concept  string
	AnimalID string
	Relation string
	Weight   float64
}

type Store struct {
	db *sql.DB
}

func Open(path, expectedSourceSHA, expectedLexiconSHA string) (*Store, error) {
	databaseURL := (&url.URL{
		Scheme:   "file",
		Path:     path,
		RawQuery: "mode=ro&immutable=1",
	}).String()
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open ConceptNet index: %w", err)
	}
	metadata, err := readMetadataDB(context.Background(), db)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("read ConceptNet index metadata: %w", err)
	}
	if metadata["schema_version"] != SchemaVersion {
		db.Close()
		return nil, fmt.Errorf("ConceptNet index schema mismatch")
	}
	if !strings.EqualFold(metadata["source_sha256"], expectedSourceSHA) {
		db.Close()
		return nil, fmt.Errorf("ConceptNet index source mismatch")
	}
	if !strings.EqualFold(metadata["lexicon_sha256"], expectedLexiconSHA) {
		db.Close()
		return nil, fmt.Errorf("ConceptNet index lexicon mismatch")
	}
	if strings.TrimSpace(metadata["generated_at"]) == "" {
		db.Close()
		return nil, fmt.Errorf("ConceptNet index is incomplete")
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping ConceptNet index: %w", err)
	}
	return &Store{db: db}, nil
}

func (store *Store) Candidates(ctx context.Context, concepts []string) ([]Edge, error) {
	unique := make([]string, 0, len(concepts))
	seen := make(map[string]struct{}, len(concepts))
	for _, concept := range concepts {
		concept = normalizeTerm(concept)
		if concept == "" {
			continue
		}
		if _, exists := seen[concept]; exists {
			continue
		}
		seen[concept] = struct{}{}
		unique = append(unique, concept)
	}
	if len(unique) == 0 {
		return []Edge{}, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
	arguments := make([]any, len(unique))
	for index, concept := range unique {
		arguments[index] = concept
	}
	rows, err := store.db.QueryContext(ctx,
		`SELECT concept, animal_id, relation, weight FROM edges WHERE concept IN (`+placeholders+`)`,
		arguments...,
	)
	if err != nil {
		return nil, fmt.Errorf("query ConceptNet candidates: %w", err)
	}
	defer rows.Close()
	edges := make([]Edge, 0)
	for rows.Next() {
		var edge Edge
		if err := rows.Scan(&edge.Concept, &edge.AnimalID, &edge.Relation, &edge.Weight); err != nil {
			return nil, fmt.Errorf("scan ConceptNet candidate: %w", err)
		}
		edges = append(edges, edge)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ConceptNet candidates: %w", err)
	}
	sort.Slice(edges, func(i, j int) bool {
		if edges[i].Concept != edges[j].Concept {
			return edges[i].Concept < edges[j].Concept
		}
		if edges[i].AnimalID != edges[j].AnimalID {
			return edges[i].AnimalID < edges[j].AnimalID
		}
		return edges[i].Relation < edges[j].Relation
	})
	return edges, nil
}

func (store *Store) Close() error {
	return store.db.Close()
}

func ReadMetadata(path string) (map[string]string, error) {
	databaseURL := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&immutable=1"}).String()
	db, err := sql.Open("sqlite", databaseURL)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	return readMetadataDB(context.Background(), db)
}

func readMetadataDB(ctx context.Context, db *sql.DB) (map[string]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT key, value FROM metadata`)
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return map[string]string{}, nil
		}
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
