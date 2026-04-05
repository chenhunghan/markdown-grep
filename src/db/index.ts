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
