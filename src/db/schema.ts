/**
 * SQLite schema for mdg.
 * Single .db file in ~/.mdg/ stores:
 *   - files: tracked markdown files with hash for incremental indexing
 *   - chunks: text chunks with embeddings (inline BLOB)
 *   - chunks_fts: FTS5 virtual table for full-text search
 *   - chunks_vec: sqlite-vec virtual table for vector similarity search
 *   - background_jobs: lease-based queue for background maintenance work
 */

export const SCHEMA_VERSION = 2;

export const INIT_SQL = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracked markdown files
CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,        -- relative path from cwd root
  abs_path    TEXT NOT NULL,               -- absolute path on disk
  file_hash   TEXT NOT NULL,               -- SHA-256 of file content
  chunk_count INTEGER NOT NULL DEFAULT 0,
  indexed_at  INTEGER NOT NULL DEFAULT 0   -- epoch ms
);

-- Text chunks with inline embedding
CREATE TABLE IF NOT EXISTS chunks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,            -- ordering within file
  content     TEXT NOT NULL,               -- raw chunk text
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  embedding   BLOB,                        -- float32 vector via sqlite-vec
  embed_model TEXT DEFAULT '',
  UNIQUE(file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_file_id ON chunks(file_id);

-- FTS5 full-text search over chunk content
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync with chunks table
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Background job queue (lease-based, deduped by job_key)
CREATE TABLE IF NOT EXISTS background_jobs (
  job_key                TEXT PRIMARY KEY,
  job_type               TEXT NOT NULL,
  root_path              TEXT NOT NULL,
  model_id               TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending',
  requested_generation   INTEGER NOT NULL DEFAULT 0,
  completed_generation   INTEGER NOT NULL DEFAULT 0,
  claimed_generation     INTEGER NOT NULL DEFAULT 0,
  lease_owner            TEXT,
  lease_until            INTEGER NOT NULL DEFAULT 0,
  attempts               INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL DEFAULT 0,
  started_at             INTEGER,
  finished_at            INTEGER,
  last_error             TEXT
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status
  ON background_jobs(status, lease_until, updated_at);
`;

/**
 * sqlite-vec virtual table must be created after loading the extension.
 * The dimension is determined at runtime from the embedding model.
 */
export function createVecTable(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${dimensions}]
);`;
}
