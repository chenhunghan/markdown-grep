/**
 * Search module: FTS and vector search over indexed markdown chunks.
 */
import { getDb, ensureVecTable } from "../db/index.ts";
import { embed, embedBatch, getEmbeddingDimensions } from "../embedder/index.ts";

export interface SearchResult {
  /** Relative file path */
  filePath: string;
  /** Chunk content */
  content: string;
  /** Line range in original file */
  startLine: number;
  endLine: number;
  /** Search score (higher = better) */
  score: number;
  /** Which search method found this */
  method: "fts" | "vector" | "hybrid";
}

export interface LineContextLine {
  lineNumber: number;
  lineText: string;
}

export interface LineSearchResult {
  filePath: string;
  lineNumber: number;
  lineText: string;
  score: number;
  method: "fts" | "vector" | "hybrid";
  context?: {
    before: LineContextLine[];
    after: LineContextLine[];
  };
}

/**
 * Ensure the embedding runtime is initialized before any SQLite access.
 * This avoids Bun's SQLite loader colliding with the vector embedder setup.
 */
export async function ensureVectorSearchReady(): Promise<number> {
  return getEmbeddingDimensions();
}

function hasWarmEmbeddings(): boolean {
  const db = getDb();
  const unembedded = db
    .prepare("SELECT COUNT(*) as count FROM chunks WHERE embedding IS NULL")
    .get() as { count: number };
  if (unembedded.count > 0) return false;

  return true;
}

/**
 * Full-text search using FTS5.
 * Translates grep-like patterns to FTS5 query syntax.
 */
export function searchFTS(
  query: string,
  options: {
    limit?: number;
    filePaths?: string[];
  } = {}
): SearchResult[] {
  const db = getDb();
  const limit = options.limit || 100;

  // Escape FTS5 special characters and build query
  const ftsQuery = buildFTSQuery(query);

  let sql = `
    SELECT
      c.id,
      c.content,
      c.start_line,
      c.end_line,
      f.path,
      rank
    FROM chunks_fts
    JOIN chunks c ON chunks_fts.rowid = c.id
    JOIN files f ON c.file_id = f.id
    WHERE chunks_fts MATCH ?
  `;

  const params: (string | number)[] = [ftsQuery];

  if (options.filePaths && options.filePaths.length > 0) {
    const placeholders = options.filePaths.map(() => "?").join(", ");
    sql += ` AND f.path IN (${placeholders})`;
    params.push(...options.filePaths);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as {
      id: number;
      content: string;
      start_line: number;
      end_line: number;
      path: string;
      rank: number;
    }[];

    return rows.map((row) => ({
      filePath: row.path,
      content: row.content,
      startLine: row.start_line,
      endLine: row.end_line,
      score: -row.rank, // FTS5 rank is negative (lower = better)
      method: "fts" as const,
    }));
  } catch {
    // If FTS query is malformed, fall back to empty results
    return [];
  }
}

/**
 * Vector similarity search using sqlite-vec.
 */
export async function searchVector(
  query: string,
  options: {
    limit?: number;
    filePaths?: string[];
  } = {}
): Promise<SearchResult[]> {
  const limit = options.limit || 20;

  // Ensure the embedder initializes before SQLite is touched.
  const dimensions = await ensureVectorSearchReady();
  ensureVecTable(dimensions);

  const db = getDb();

  // Embed the query
  const queryVector = await embed(query, "query");

  // sqlite-vec requires k=? constraint in the WHERE clause of the virtual table
  // Use a subquery to get KNN results first, then join for metadata
  const fetchLimit = limit * (options.filePaths ? 5 : 1); // over-fetch if filtering

  const sql = `
    SELECT
      knn.chunk_id,
      knn.distance,
      c.content,
      c.start_line,
      c.end_line,
      f.path
    FROM (
      SELECT chunk_id, distance
      FROM chunks_vec
      WHERE embedding MATCH ? AND k = ?
    ) knn
    JOIN chunks c ON knn.chunk_id = c.id
    JOIN files f ON c.file_id = f.id
    ORDER BY knn.distance ASC
  `;

  const rows = db.prepare(sql).all(
    new Float32Array(queryVector),
    fetchLimit
  ) as {
    chunk_id: number;
    distance: number;
    content: string;
    start_line: number;
    end_line: number;
    path: string;
  }[];

  let results = rows.map((row) => ({
    filePath: row.path,
    content: row.content,
    startLine: row.start_line,
    endLine: row.end_line,
    score: 1 / (1 + row.distance), // Convert distance to similarity score
    method: "vector" as const,
  }));

  // Apply file path filter
  if (options.filePaths && options.filePaths.length > 0) {
    const pathSet = new Set(options.filePaths);
    results = results.filter((r) => pathSet.has(r.filePath));
  }

  return results.slice(0, limit);
}

/**
 * Find files whose chunks match an FTS query.
 * Used for grep acceleration: coarse filter to narrow which files to grep.
 */
export function findMatchingFiles(query: string): string[] {
  const db = getDb();
  const ftsQuery = buildFTSQuery(query);

  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT f.path
         FROM chunks_fts
         JOIN chunks c ON chunks_fts.rowid = c.id
         JOIN files f ON c.file_id = f.id
         WHERE chunks_fts MATCH ?
         LIMIT 500`
      )
      .all(ftsQuery) as { path: string }[];

    return rows.map((r) => r.path);
  } catch {
    return [];
  }
}

/**
 * Build FTS5 query from a grep-like pattern.
 * - Simple words become AND queries
 * - Quoted strings become phrase queries
 * - Handles common patterns
 */
function buildFTSQuery(pattern: string): string {
  // If it looks like an FTS5 query already, pass through
  if (
    pattern.includes('"') ||
    pattern.includes("AND") ||
    pattern.includes("OR") ||
    pattern.includes("NOT") ||
    pattern.includes("NEAR")
  ) {
    return pattern;
  }

  // Escape special FTS5 characters
  const escaped = pattern
    .replace(/[*^${}()|[\]\\]/g, "")
    .trim();

  if (!escaped) return '""';

  // Split into words and join with AND
  const words = escaped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 1) {
    return `"${words[0]}"`;
  }

  // Use phrase matching for multi-word queries
  return `"${words.join(" ")}"`;
}

/**
 * Hybrid search: combines FTS5 and vector search using Reciprocal Rank Fusion (RRF).
 *
 * RRF formula: score(d) = sum(1 / (k + rank_i(d)))
 * where k is a constant (default 60) and rank_i is the rank in result set i.
 *
 * This approach (from codemogger's architecture) avoids the need to normalize
 * scores across different search methods.
 */
export async function searchHybrid(
  query: string,
  options: {
    limit?: number;
    filePaths?: string[];
    /** RRF constant k — higher values reduce impact of high rankings */
    rrfK?: number;
    /** Weight for FTS results (default 1.0) */
    ftsWeight?: number;
    /** Weight for vector results (default 1.0) */
    vecWeight?: number;
    /** Dependency overrides for tests */
    deps?: {
      searchFTS?: typeof searchFTS;
      searchVector?: typeof searchVector;
      ensureVectorSearchReady?: typeof ensureVectorSearchReady;
    };
  } = {}
): Promise<SearchResult[]> {
  const searchFtsFn = options.deps?.searchFTS ?? searchFTS;
  const searchVectorFn = options.deps?.searchVector ?? searchVector;
  const ensureVectorSearchReadyFn =
    options.deps?.ensureVectorSearchReady ?? ensureVectorSearchReady;

  const limit = options.limit || 20;
  const k = options.rrfK || 60;
  const ftsWeight = options.ftsWeight ?? 1.0;
  const vecWeight = options.vecWeight ?? 1.0;

  // Fetch more candidates than needed for fusion
  const fetchLimit = limit * 3;

  if (!hasWarmEmbeddings()) {
    const ftsOnly = searchFtsFn(query, { limit, filePaths: options.filePaths });
    return ftsOnly.map((result) => ({ ...result, method: "hybrid" as const }));
  }

  // Initialize vector search before any SQLite access in the parallel branches.
  await ensureVectorSearchReadyFn();

  // Run FTS first, then vector search to avoid sqlite connection contention.
  const ftsResults = await Promise.resolve(
    searchFtsFn(query, { limit: fetchLimit, filePaths: options.filePaths })
  );
  const vecResults = await searchVectorFn(query, {
    limit: fetchLimit,
    filePaths: options.filePaths,
  });

  // Build RRF scores keyed by chunk identity (filePath:startLine)
  const rrfScores = new Map<string, { score: number; result: SearchResult }>();

  function chunkKey(r: SearchResult): string {
    return `${r.filePath}:${r.startLine}`;
  }

  // Score FTS results
  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i]!;
    const key = chunkKey(r);
    const rrfScore = ftsWeight / (k + i + 1);
    const existing = rrfScores.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      rrfScores.set(key, { score: rrfScore, result: { ...r, method: "hybrid" } });
    }
  }

  // Score vector results
  for (let i = 0; i < vecResults.length; i++) {
    const r = vecResults[i]!;
    const key = chunkKey(r);
    const rrfScore = vecWeight / (k + i + 1);
    const existing = rrfScores.get(key);
    if (existing) {
      existing.score += rrfScore;
    } else {
      rrfScores.set(key, { score: rrfScore, result: { ...r, method: "hybrid" } });
    }
  }

  // Sort by RRF score descending, return top results
  return Array.from(rrfScores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, result }) => ({ ...result, score }));
}

/**
 * Reduce chunk-level search results to the most semantically similar line
 * within each chunk.
 */
export async function selectBestLines(
  query: string,
  results: SearchResult[]
): Promise<LineSearchResult[]> {
  if (results.length === 0) return [];

  const queryVector = await embed(query, "query");
  const queryNorm = vectorNorm(queryVector);

  const lineCandidates: {
    resultIndex: number;
    lineIndex: number;
    line: string;
  }[] = [];

  for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
    const result = results[resultIndex]!;
    const lines = result.content.split("\n");
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!.trim();
      if (!line) continue;
      lineCandidates.push({ resultIndex, lineIndex, line });
    }
  }

  if (lineCandidates.length === 0) {
    return results.map((result) => ({
      filePath: result.filePath,
      lineNumber: result.startLine,
      lineText: result.content,
      score: result.score,
      method: result.method,
      context: { before: [], after: [] },
    }));
  }

  const lineVectors = await embedBatch(
    lineCandidates.map((candidate) => candidate.line),
    "document"
  );

  const bestByResult = new Map<number, { lineIndex: number; score: number }>();

  for (let i = 0; i < lineCandidates.length; i++) {
    const candidate = lineCandidates[i]!;
    const lineVector = lineVectors[i]!;
    const similarity = cosineSimilarity(queryVector, queryNorm, lineVector);
    const existing = bestByResult.get(candidate.resultIndex);

    if (!existing || similarity > existing.score) {
      bestByResult.set(candidate.resultIndex, {
        lineIndex: candidate.lineIndex,
        score: similarity,
      });
    }
  }

  const lineResults = results.map((result, index): LineSearchResult | SearchResult => {
    const best = bestByResult.get(index);
    if (!best) return result;

    const lines = result.content.split("\n");
    const selectedLine = lines[best.lineIndex];
    if (!selectedLine) return result;

    const before = lines.slice(0, best.lineIndex).map((line, offset) => ({
      lineNumber: result.startLine + offset,
      lineText: line,
    }));
    const after = lines.slice(best.lineIndex + 1).map((line, offset) => ({
      lineNumber: result.startLine + best.lineIndex + offset + 1,
      lineText: line,
    }));

    return {
      filePath: result.filePath,
      lineNumber: result.startLine + best.lineIndex,
      lineText: selectedLine,
      score: result.score,
      method: result.method,
      context: {
        before,
        after,
      },
    };
  });

  const deduped = new Map<string, LineSearchResult>();
  for (const result of lineResults) {
    if (!("lineNumber" in result)) continue;
    const key = `${result.filePath}:${result.lineNumber}`;
    const existing = deduped.get(key);
    if (!existing || existing.score < result.score) {
      deduped.set(key, result);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => b.score - a.score);
}

function vectorNorm(vector: number[]): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum) || 1;
}

function cosineSimilarity(queryVector: number[], queryNorm: number, lineVector: number[]): number {
  let dot = 0;
  let lineSum = 0;
  for (let i = 0; i < queryVector.length && i < lineVector.length; i++) {
    dot += queryVector[i]! * lineVector[i]!;
    lineSum += lineVector[i]! * lineVector[i]!;
  }
  const lineNorm = Math.sqrt(lineSum) || 1;
  return dot / (queryNorm * lineNorm);
}
