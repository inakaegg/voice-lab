package conceptindex

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/inakaegg/voice-lab/services/zoovoice/internal/animaldefs"
	_ "modernc.org/sqlite"
)

type BuildOptions struct {
	SourcePath      string
	OutputPath      string
	AliasesPath     string
	SourceVersion   string
	SourceURL       string
	SourceSHA256    string
	CheckpointEvery int64
}

type conceptNetMetadata struct {
	Weight float64 `json:"weight"`
}

func Build(ctx context.Context, options BuildOptions, progress io.Writer) error {
	if err := validateBuildOptions(options); err != nil {
		return err
	}
	if _, err := os.Stat(options.OutputPath); err == nil {
		return fmt.Errorf("output already exists: %s", options.OutputPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect output: %w", err)
	}

	aliases, err := animaldefs.Load(options.AliasesPath)
	if err != nil {
		return err
	}
	aliasLookup := make(map[string]string)
	for animalID, entry := range aliases {
		for _, term := range append(append([]string{}, entry.Terms...), entry.Onomatopoeia...) {
			aliasLookup[normalizeTerm(term)] = animalID
		}
	}
	aliasSHA, err := FileSHA256(options.AliasesPath)
	if err != nil {
		return fmt.Errorf("hash association aliases: %w", err)
	}

	partialPath := options.OutputPath + ".partial"
	if err := os.MkdirAll(filepath.Dir(options.OutputPath), 0o755); err != nil {
		return fmt.Errorf("create output directory: %w", err)
	}
	db, err := sql.Open("sqlite", partialPath)
	if err != nil {
		return fmt.Errorf("open partial index: %w", err)
	}
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		db.Close()
		return fmt.Errorf("initialize index schema: %w", err)
	}
	resumeLine, err := initializeOrValidateMetadata(ctx, db, options, aliasSHA)
	if err != nil {
		db.Close()
		return err
	}

	source, err := os.Open(options.SourcePath)
	if err != nil {
		db.Close()
		return fmt.Errorf("open ConceptNet source: %w", err)
	}
	gzipReader, err := gzip.NewReader(source)
	if err != nil {
		source.Close()
		db.Close()
		return fmt.Errorf("open ConceptNet gzip stream: %w", err)
	}

	buildErr := scanAndInsert(ctx, db, gzipReader, aliasLookup, resumeLine, options.CheckpointEvery, progress)
	closeGzipErr := gzipReader.Close()
	closeSourceErr := source.Close()
	if buildErr != nil {
		db.Close()
		return buildErr
	}
	if closeGzipErr != nil {
		db.Close()
		return fmt.Errorf("close ConceptNet gzip stream: %w", closeGzipErr)
	}
	if closeSourceErr != nil {
		db.Close()
		return fmt.Errorf("close ConceptNet source: %w", closeSourceErr)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO metadata(key, value) VALUES('generated_at', ?)
		 ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
		time.Now().UTC().Format(time.RFC3339),
	); err != nil {
		db.Close()
		return fmt.Errorf("finalize index metadata: %w", err)
	}
	if err := db.Close(); err != nil {
		return fmt.Errorf("close completed index: %w", err)
	}
	if err := os.Rename(partialPath, options.OutputPath); err != nil {
		return fmt.Errorf("publish completed index: %w", err)
	}
	return nil
}

func validateBuildOptions(options BuildOptions) error {
	for name, value := range map[string]string{
		"source path": options.SourcePath, "output path": options.OutputPath,
		"aliases path": options.AliasesPath, "source version": options.SourceVersion,
		"source URL": options.SourceURL, "source SHA-256": options.SourceSHA256,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if len(options.SourceSHA256) != sha256.Size*2 {
		return fmt.Errorf("source SHA-256 must contain 64 hexadecimal characters")
	}
	if _, err := hex.DecodeString(options.SourceSHA256); err != nil {
		return fmt.Errorf("source SHA-256: %w", err)
	}
	if options.CheckpointEvery <= 0 {
		return fmt.Errorf("checkpoint interval must be positive")
	}
	return nil
}

func initializeOrValidateMetadata(
	ctx context.Context,
	db *sql.DB,
	options BuildOptions,
	aliasSHA string,
) (int64, error) {
	existing, err := readMetadataDB(ctx, db)
	if err != nil {
		return 0, fmt.Errorf("read partial index metadata: %w", err)
	}
	want := map[string]string{
		"schema_version": SchemaVersion,
		"source_version": options.SourceVersion,
		"source_url":     options.SourceURL,
		"source_sha256":  strings.ToLower(options.SourceSHA256),
		"alias_sha256":   aliasSHA,
		"license":        "CC BY-SA 4.0",
		"transformation": transformationDescription,
	}
	if len(existing) == 0 {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return 0, fmt.Errorf("begin metadata transaction: %w", err)
		}
		for key, value := range want {
			if _, err := tx.ExecContext(ctx, `INSERT INTO metadata(key, value) VALUES(?, ?)`, key, value); err != nil {
				tx.Rollback()
				return 0, fmt.Errorf("write metadata %s: %w", key, err)
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO metadata(key, value) VALUES('lines_processed', '0')`); err != nil {
			tx.Rollback()
			return 0, fmt.Errorf("initialize progress metadata: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("commit metadata: %w", err)
		}
		return 0, nil
	}
	for key, value := range want {
		if existing[key] != value {
			return 0, fmt.Errorf("partial index metadata mismatch for %s", key)
		}
	}
	resumeLine, err := strconv.ParseInt(existing["lines_processed"], 10, 64)
	if err != nil || resumeLine < 0 {
		return 0, fmt.Errorf("invalid partial index lines_processed metadata")
	}
	return resumeLine, nil
}

func scanAndInsert(
	ctx context.Context,
	db *sql.DB,
	reader io.Reader,
	aliasLookup map[string]string,
	resumeLine int64,
	checkpointEvery int64,
	progress io.Writer,
) error {
	scanner := bufio.NewScanner(reader)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 4*1024*1024)
	var lineNumber int64
	var tx *sql.Tx
	var statement *sql.Stmt

	begin := func() error {
		var err error
		tx, err = db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		statement, err = tx.PrepareContext(ctx, `
			INSERT INTO edges(concept, animal_id, relation, weight) VALUES(?, ?, ?, ?)
			ON CONFLICT(concept, animal_id, relation) DO UPDATE SET
			weight = MAX(weight, excluded.weight)`)
		if err != nil {
			tx.Rollback()
		}
		return err
	}
	commit := func(processed int64) error {
		if statement != nil {
			if err := statement.Close(); err != nil {
				tx.Rollback()
				return err
			}
		}
		if _, err := tx.ExecContext(ctx,
			`UPDATE metadata SET value = ? WHERE key = 'lines_processed'`,
			strconv.FormatInt(processed, 10),
		); err != nil {
			tx.Rollback()
			return err
		}
		return tx.Commit()
	}
	if err := begin(); err != nil {
		return fmt.Errorf("begin edge transaction: %w", err)
	}
	defer func() {
		if statement != nil {
			statement.Close()
		}
		if tx != nil {
			tx.Rollback()
		}
	}()

	for scanner.Scan() {
		lineNumber++
		if lineNumber <= resumeLine {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		edge, ok, err := parseConceptNetLine(scanner.Text(), aliasLookup)
		if err != nil {
			return fmt.Errorf("parse ConceptNet line %d: %w", lineNumber, err)
		}
		if ok {
			if _, err := statement.ExecContext(ctx, edge.Concept, edge.AnimalID, edge.Relation, edge.Weight); err != nil {
				return fmt.Errorf("insert ConceptNet line %d: %w", lineNumber, err)
			}
		}
		if lineNumber%checkpointEvery == 0 {
			if err := commit(lineNumber); err != nil {
				return fmt.Errorf("checkpoint ConceptNet line %d: %w", lineNumber, err)
			}
			tx = nil
			statement = nil
			if progress != nil {
				_, _ = fmt.Fprintf(progress, "%s lines_processed=%d\n", time.Now().In(jstLocation()).Format(time.RFC3339), lineNumber)
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := begin(); err != nil {
				return fmt.Errorf("resume edge transaction: %w", err)
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("scan ConceptNet source: %w", err)
	}
	if err := commit(lineNumber); err != nil {
		return fmt.Errorf("commit ConceptNet completion: %w", err)
	}
	tx = nil
	statement = nil
	return nil
}

func parseConceptNetLine(line string, aliases map[string]string) (Edge, bool, error) {
	fields := strings.Split(line, "\t")
	if len(fields) != 5 {
		return Edge{}, false, fmt.Errorf("expected 5 tab-separated fields, got %d", len(fields))
	}
	left, leftJapanese := parseJapaneseConcept(fields[2])
	right, rightJapanese := parseJapaneseConcept(fields[3])
	if !leftJapanese || !rightJapanese {
		return Edge{}, false, nil
	}
	leftAnimal, leftIsAnimal := aliases[left]
	rightAnimal, rightIsAnimal := aliases[right]
	if leftIsAnimal == rightIsAnimal {
		return Edge{}, false, nil
	}
	concept := left
	animalID := rightAnimal
	if leftIsAnimal {
		concept = right
		animalID = leftAnimal
	}
	if concept == "" {
		return Edge{}, false, nil
	}
	var metadata conceptNetMetadata
	if err := json.Unmarshal([]byte(fields[4]), &metadata); err != nil {
		return Edge{}, false, fmt.Errorf("decode assertion metadata: %w", err)
	}
	if metadata.Weight <= 0 {
		return Edge{}, false, nil
	}
	return Edge{
		Concept:  concept,
		AnimalID: animalID,
		Relation: strings.TrimPrefix(fields[1], "/r/"),
		Weight:   metadata.Weight,
	}, true, nil
}

func parseJapaneseConcept(uri string) (string, bool) {
	if !strings.HasPrefix(uri, "/c/ja/") {
		return "", false
	}
	remainder := strings.TrimPrefix(uri, "/c/ja/")
	term := strings.SplitN(remainder, "/", 2)[0]
	decoded, err := url.PathUnescape(term)
	if err != nil {
		return "", false
	}
	return normalizeTerm(decoded), true
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

func jstLocation() *time.Location {
	location, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return time.FixedZone("JST", 9*60*60)
	}
	return location
}
