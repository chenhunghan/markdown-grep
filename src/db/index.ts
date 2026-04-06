/**
 * Database module — manages the SQLite database in ~/.mdg/
 *
 * sqlite-vec is loaded by manually resolving the dylib path rather than
 * using `import * as sqliteVec from "sqlite-vec"`, because `bun build --compile`
 * can't resolve the platform-specific native extension at bundle time.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { platform, arch } from "node:process";
import { INIT_SQL, SCHEMA_VERSION, createVecTable } from "./schema.ts";

const MDG_DIR = join(homedir(), ".mdg");
const MDG_LIB_DIR = join(MDG_DIR, "lib");
const DB_PATH = join(MDG_DIR, "mdg.db");

let _db: Database | null = null;

const EMBEDDING_JOB_TYPE = "embedding_refresh";
const JOB_LEASE_MS = 2 * 60 * 1000;
const JOB_STALE_MS = 30 * 1000;

export interface BackgroundJob {
  job_key: string;
  job_type: string;
  root_path: string;
  model_id: string;
  status: string;
  requested_generation: number;
  completed_generation: number;
  claimed_generation: number;
  lease_owner: string | null;
  lease_until: number;
  attempts: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
}

export interface EnqueueEmbeddingJobArgs {
  rootPath: string;
  modelId: string;
}

export interface ClaimEmbeddingJobArgs {
  leaseOwner: string;
  now?: number;
  rootPath?: string;
  modelId?: string;
}

export interface ClaimedBackgroundJob {
  job_key: string;
  root_path: string;
  model_id: string;
  requested_generation: number;
  claimed_generation: number;
}

/**
 * On macOS, the system SQLite is compiled without extension loading.
 * Swap in Homebrew's SQLite if available.
 */
function ensureExtensionSupport(): void {
  if (process.platform !== "darwin") return;

  const candidates = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      Database.setCustomSQLite(path);
      return;
    }
  }
}

/**
 * Resolve the sqlite-vec extension path.
 * Tries multiple strategies to find vec0.dylib/vec0.so:
 *   1. node_modules (dev/bun run mode)
 *   2. ~/.mdg/lib/ (compiled binary mode — user installs once)
 *   3. Next to the binary itself
 */
function resolveVecExtensionPath(): string {
  const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
  const os = platform === "win32" ? "windows" : platform;
  const pkgName = `sqlite-vec-${os}-${arch}`;
  const fileName = `vec0.${suffix}`;

  // Strategy 1: try the npm package directly (works in dev mode)
  try {
    const sqliteVec = require("sqlite-vec");
    if (sqliteVec.getLoadablePath) {
      return sqliteVec.getLoadablePath();
    }
  } catch {
    // Not available (compiled binary), continue
  }

  // Strategy 2: try node_modules relative to cwd
  const cwdPath = join(process.cwd(), "node_modules", pkgName, fileName);
  if (existsSync(cwdPath)) return cwdPath;

  // Strategy 3: ~/.mdg/lib/
  const mdgLibPath = join(MDG_LIB_DIR, fileName);
  if (existsSync(mdgLibPath)) return mdgLibPath;

  // Strategy 4: next to the binary
  const binaryDir = dirname(process.execPath);
  const binPath = join(binaryDir, fileName);
  if (existsSync(binPath)) return binPath;

  throw new Error(
    `sqlite-vec extension not found. Please either:\n` +
    `  1. Run from a directory with node_modules/ containing sqlite-vec, or\n` +
    `  2. Copy ${fileName} to ~/.mdg/lib/\n` +
    `     (from node_modules/${pkgName}/${fileName})`
  );
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getMdgDir(): string {
  return MDG_DIR;
}

export function enqueueEmbeddingRefresh(args: EnqueueEmbeddingJobArgs): void {
  const db = getDb();
  const now = Date.now();
  const jobKey = `${EMBEDDING_JOB_TYPE}:${args.rootPath}:${args.modelId}`;

  db.prepare(
    `INSERT INTO background_jobs (
      job_key, job_type, root_path, model_id,
      status, requested_generation, completed_generation, claimed_generation,
      lease_owner, lease_until, attempts, created_at, updated_at, started_at, finished_at, last_error
    ) VALUES (?, ?, ?, ?, 'pending', 1, 0, 0, NULL, 0, 0, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(job_key) DO UPDATE SET
      requested_generation = background_jobs.requested_generation + 1,
      status = CASE
        WHEN background_jobs.completed_generation < background_jobs.requested_generation + 1 THEN 'pending'
        ELSE background_jobs.status
      END,
      updated_at = excluded.updated_at,
      last_error = NULL
    `
  ).run(
    jobKey,
    EMBEDDING_JOB_TYPE,
    args.rootPath,
    args.modelId,
    now,
    now
  );
}

export function claimNextEmbeddingJob(args: ClaimEmbeddingJobArgs): ClaimedBackgroundJob | null {
  const db = getDb();
  const now = args.now ?? Date.now();
  const leaseUntil = now + JOB_LEASE_MS;
  const filters: string[] = [];
  const params: (string | number)[] = [EMBEDDING_JOB_TYPE, now];

  if (args.rootPath) {
    filters.push("root_path = ?");
    params.push(args.rootPath);
  }
  if (args.modelId) {
    filters.push("model_id = ?");
    params.push(args.modelId);
  }

  const filterSql = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";

  const tx = db.transaction(() => {
    const stale = db
      .prepare(
        `UPDATE background_jobs
         SET status = 'pending', lease_owner = NULL, lease_until = 0, updated_at = ?
         WHERE job_type = ?
           AND status = 'running'
           AND lease_until < ?
           AND completed_generation < requested_generation`
      )
      .run(now, EMBEDDING_JOB_TYPE, now - JOB_STALE_MS);

    void stale;

    const job = db
      .prepare(
        `SELECT * FROM background_jobs
         WHERE job_type = ?
           AND status IN ('pending', 'running')
           AND completed_generation < requested_generation
           AND (lease_until = 0 OR lease_until < ?)
           ${filterSql}
         ORDER BY updated_at ASC
         LIMIT 1`
      )
      .get(...params) as BackgroundJob | null;

    if (!job) return null;

    const updated = db
      .prepare(
        `UPDATE background_jobs
         SET status = 'running',
             lease_owner = ?,
             lease_until = ?,
             claimed_generation = requested_generation,
             attempts = attempts + 1,
             started_at = COALESCE(started_at, ?),
             updated_at = ?
         WHERE job_key = ?
           AND (lease_until = 0 OR lease_until < ?)
           AND completed_generation < requested_generation`
      )
      .run(args.leaseOwner, leaseUntil, now, now, job.job_key, now);

    if (updated.changes === 0) return null;

      return {
        job_key: job.job_key,
        root_path: job.root_path,
        model_id: job.model_id,
        requested_generation: job.requested_generation,
        claimed_generation: job.claimed_generation || job.requested_generation,
      };
  });

  return tx();
}

export function completeEmbeddingJob(jobKey: string, generation: number): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE background_jobs
     SET status = CASE WHEN requested_generation > ? THEN 'pending' ELSE 'done' END,
         completed_generation = MAX(completed_generation, ?),
         lease_owner = NULL,
         lease_until = 0,
         finished_at = ?,
         updated_at = ?,
         last_error = NULL
     WHERE job_key = ?`
  ).run(generation, generation, now, now, jobKey);
}

export function failEmbeddingJob(jobKey: string, error: string): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE background_jobs
     SET status = 'pending',
         lease_owner = NULL,
         lease_until = 0,
         updated_at = ?,
         last_error = ?,
         finished_at = NULL
     WHERE job_key = ?`
  ).run(now, error, jobKey);
}

export function getEmbeddingJobState(rootPath: string, modelId: string): BackgroundJob | null {
  const db = getDb();
  return (
    db.prepare(
      `SELECT * FROM background_jobs WHERE job_key = ? LIMIT 1`
    ).get(`${EMBEDDING_JOB_TYPE}:${rootPath}:${modelId}`) as BackgroundJob | null
  );
}

export function getDb(): Database {
  if (_db) return _db;

  // Ensure ~/.mdg exists
  if (!existsSync(MDG_DIR)) {
    mkdirSync(MDG_DIR, { recursive: true });
  }

  // Swap in Homebrew SQLite on macOS for extension loading support
  ensureExtensionSupport();

  const db = new Database(DB_PATH);

  // Performance pragmas
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Load sqlite-vec extension
  const vecPath = resolveVecExtensionPath();
  db.loadExtension(vecPath);

  // Initialize schema
  db.exec(INIT_SQL);

  // Check/set schema version
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | null;

  if (!row) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION)
    );
  }

  _db = db;
  return db;
}

/**
 * Ensure the vec0 virtual table exists with the correct dimensions.
 * Called after we know the embedding dimension from the model.
 */
export function ensureVecTable(dimensions: number): void {
  const db = getDb();

  // Check if table exists
  const exists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'"
    )
    .get();

  if (!exists) {
    db.exec(createVecTable(dimensions));
    return;
  }

  // If table exists, check stored dimension matches
  const storedDim = db
    .prepare("SELECT value FROM meta WHERE key = 'vec_dimensions'")
    .get() as { value: string } | null;

  if (storedDim && Number(storedDim.value) !== dimensions) {
    // Dimension changed (model switched) — rebuild vec table
    db.exec("DROP TABLE IF EXISTS chunks_vec");
    db.exec(createVecTable(dimensions));
    // Clear all embeddings so they get regenerated
    db.exec("UPDATE chunks SET embedding = NULL, embed_model = ''");
  }

  // Store current dimensions
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dimensions', ?)"
  ).run(String(dimensions));
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
