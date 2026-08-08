package synonymindex

// SchemaVersion は同義語indexの構造版数である。構造を変えたら上げる。
const SchemaVersion = "1"

const schemaSQL = `
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS synonyms (
  term TEXT NOT NULL,
  synonym TEXT NOT NULL,
  part_of_speech TEXT NOT NULL,
  synset TEXT NOT NULL,
  PRIMARY KEY (term, synonym, synset)
);
CREATE INDEX IF NOT EXISTS synonyms_term_idx ON synonyms(term);
`

const transformationDescription = "Japanese WordNet Lemma and Form spellings as query terms mapped to canonical Lemmas from other lexical entries in the same synset"
