package conceptindex

const SchemaVersion = "2"

const schemaSQL = `
PRAGMA journal_mode = DELETE;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  concept TEXT NOT NULL,
  animal_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL,
  PRIMARY KEY (concept, animal_id, relation)
);
CREATE INDEX IF NOT EXISTS edges_concept_idx ON edges(concept);
`

const transformationDescription = "Japanese ConceptNet 1-hop edges whose opposite endpoint matches a generated Zoovoice animal lexicon term; duplicate weights keep the maximum"
