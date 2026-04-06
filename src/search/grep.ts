/**
 * Grep execution via just-bash with FTS acceleration.
 *
 * Flow:
 *   1. If index exists, use FTS to find candidate files (coarse filter)
 *   2. Narrow the grep args to only those files
 *   3. Execute grep via just-bash for exact output formatting
 *   4. If the hybrid path is used, use vector search for ranking
 */
import { Bash } from "just-bash";
import { MdgFs } from "../fs/mdgfs.ts";
import { findMatchingFiles, searchVector, searchHybrid, selectBestLines } from "../search/index.ts";
import type { LineSearchResult } from "../search/index.ts";

export interface GrepOptions {
  /** The search pattern */
  pattern: string;
  /** File/directory paths to search (default: current directory) */
  paths: string[];
  /** Raw grep flags (e.g., -i, -n, -r, -l, etc.) */
  flags: string[];
  /** Use hybrid search (RRF fusion of FTS + vector) */
  hybrid?: boolean;
  /** Working directory */
  cwd: string;
  /** Pattern was supplied via -e/--regexp */
  patternFromFlag?: boolean;
}

export interface GrepResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a grep-like search over markdown files.
 */
export async function executeGrep(options: GrepOptions): Promise<GrepResult> {
  const { pattern, paths, flags, cwd, patternFromFlag = false } = options;

  // Hybrid search mode (RRF fusion of FTS + vector)
  if (options.hybrid) {
    if (requiresExactFormatting(flags)) {
      return executeNativeGrep(pattern, paths, flags, cwd, patternFromFlag);
    }
    return executeHybridSearch(pattern, paths, cwd, flags);
  }

  return executeNativeGrep(pattern, paths, flags, cwd, patternFromFlag);
}

function requiresExactFormatting(flags: string[]): boolean {
  return (
    flags.includes("-c") ||
    flags.includes("--count") ||
    flags.includes("-A") ||
    flags.includes("--after-context") ||
    flags.includes("-B") ||
    flags.includes("--before-context") ||
    flags.includes("-C") ||
    flags.includes("--context")
  );
}

async function executeNativeGrep(
  pattern: string,
  paths: string[],
  flags: string[],
  cwd: string,
  patternFromFlag: boolean
): Promise<GrepResult> {
  // Build the grep command
  const grepArgs = buildGrepArgs(pattern, paths, flags, patternFromFlag);

  // Try FTS acceleration: use the index to find candidate files
  let narrowedArgs = grepArgs;
  if (paths.length === 0) {
    try {
      const candidateFiles = findMatchingFiles(pattern);
      if (candidateFiles.length > 0 && candidateFiles.length < 200) {
        // Narrow grep to only candidate files (FTS coarse filter)
        narrowedArgs = buildNarrowedGrepArgs(
          pattern,
          candidateFiles,
          flags,
          patternFromFlag
        );
      }
    } catch {
      // Index may not exist yet, fall through to full grep
    }
  }

  // Execute via just-bash with our read-only VFS
  const mdgFs = new MdgFs(cwd);
  const bash = new Bash({ fs: mdgFs, cwd: "/" });

  try {
    const result = await bash.exec(`grep ${narrowedArgs}`);
    return {
      stdout: normalizeDefaultOutput(result.stdout, paths.length === 0),
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  } catch (e: any) {
    return {
      stdout: "",
      stderr: e.message || "grep failed",
      exitCode: 2,
    };
  }
}

function normalizeDefaultOutput(stdout: string, prefixDotSlash: boolean): string {
  if (!prefixDotSlash || !stdout) return stdout;

  return stdout
    .split("\n")
    .map((line) => {
      if (
        line === "" ||
        line.startsWith("./") ||
        line.startsWith("/") ||
        line === "--" ||
        line.startsWith("Binary file")
      ) {
        return line;
      }
      return `./${line}`;
    })
    .join("\n");
}

/**
 * Build grep arguments string.
 */
function buildGrepArgs(
  pattern: string,
  paths: string[],
  flags: string[],
  patternFromFlag: boolean
): string {
  const parts: string[] = [];
  const flagsWithValue = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "--include",
    "--exclude",
    "--exclude-dir",
    "--label",
    "--color",
    "--colour",
  ]);

  // Always add recursive flag for directory searches
  const hasRecursive = flags.some((f) => f === "-r" || f === "-R" || f === "--recursive");

  // Add user flags, preserving flag/value pairs
  let patternConsumed = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    parts.push(flag);

    if (!flagsWithValue.has(flag)) continue;

    const value = flags[i + 1];
    if (value === undefined) continue;
    parts.push(`'${value.replace(/'/g, "'\\''")}'`);
    i++;

    if (flag === "-e" || flag === "--regexp") {
      patternConsumed = true;
    }
  }

  // Add pattern (properly quoted)
  if (!patternFromFlag || !patternConsumed) {
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);
  }

  // Add paths or default to current dir
  if (paths.length > 0) {
    for (const p of paths) {
      parts.push(`'${p.replace(/'/g, "'\\''")}'`);
    }
  } else {
    if (!hasRecursive) {
      parts.push("-r");
    }
    parts.push(".");
  }

  return parts.join(" ");
}

/**
 * Build narrowed grep args targeting only FTS-matched files.
 * Keeps -r flag because just-bash's grep requires it even for file targets.
 */
function buildNarrowedGrepArgs(
  pattern: string,
  candidateFiles: string[],
  flags: string[],
  patternFromFlag: boolean
): string {
  const parts: string[] = [];
  const flagsWithValue = new Set([
    "-e",
    "--regexp",
    "-f",
    "--file",
    "-m",
    "--max-count",
    "-A",
    "--after-context",
    "-B",
    "--before-context",
    "-C",
    "--context",
    "--include",
    "--exclude",
    "--exclude-dir",
    "--label",
    "--color",
    "--colour",
  ]);

  // Keep all flags including -r (just-bash grep needs it for file reads)
  let patternConsumed = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    parts.push(flag);

    if (!flagsWithValue.has(flag)) continue;

    const value = flags[i + 1];
    if (value === undefined) continue;
    parts.push(`'${value.replace(/'/g, "'\\''")}'`);
    i++;

    if (flag === "-e" || flag === "--regexp") {
      patternConsumed = true;
    }
  }

  // Ensure -r is present for just-bash compatibility
  const hasRecursive = flags.some(
    (f) => f === "-r" || f === "-R" || f === "--recursive"
  );
  if (!hasRecursive) {
    parts.push("-r");
  }

  // Add pattern unless it came from -e/--regexp
  if (!patternFromFlag || !patternConsumed) {
    parts.push(`'${pattern.replace(/'/g, "'\\''")}'`);
  }

  // Add only the candidate files
  for (const f of candidateFiles) {
    parts.push(`'${f.replace(/'/g, "'\\''")}'`);
  }

  return parts.join(" ");
}

/**
 * Format search results (vector, hybrid) as grep-like output.
 */
export function formatSearchResults(
  results: LineSearchResult[],
  flags: string[],
  options: { explicitPaths?: boolean } = {}
): GrepResult {
  if (results.length === 0) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }

  const explicitPaths = options.explicitPaths ?? false;
  const showLineNumbers = flags.includes("-n") || flags.includes("--line-number");
  const showFilenames =
    flags.includes("-H") ||
    flags.includes("--with-filename") ||
    !explicitPaths ||
    results.length > 1;
  const onlyFilenames = flags.includes("-l") || flags.includes("--files-with-matches");
  const countMode = flags.includes("-c") || flags.includes("--count");
  const contextBefore = getContextCount(flags, "-B", "--before-context");
  const contextAfter = getContextCount(flags, "-A", "--after-context");
  const contextAny = contextBefore > 0 || contextAfter > 0 || flags.includes("-C") || flags.includes("--context");

  if (onlyFilenames) {
    const uniqueFiles = [...new Set(results.map((r) => r.filePath))];
    return {
      stdout: uniqueFiles.join("\n") + "\n",
      stderr: "",
      exitCode: 0,
    };
  }

  if (countMode) {
    const counts = new Map<string, number>();
    for (const result of results) {
      counts.set(result.filePath, (counts.get(result.filePath) || 0) + 1);
    }
    const lines = Array.from(counts.entries()).map(([filePath, count]) => {
      const displayPath = explicitPaths ? filePath : `./${filePath}`;
      return showFilenames ? `${displayPath}:${count}` : `${count}`;
    });
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  const lines: string[] = [];
  for (const result of results) {
    const displayPath = explicitPaths ? result.filePath : `./${result.filePath}`;
    const baseLine = result.lineText.trim();
    if (!baseLine) continue;

    if (!contextAny) {
      let output = "";
      if (showFilenames) output += `${displayPath}:`;
      if (showLineNumbers) output += `${result.lineNumber}:`;
      output += baseLine;
      lines.push(output);
      continue;
    }

    if (contextBefore > 0 || contextAfter > 0 || flags.includes("-C") || flags.includes("--context")) {
      const beforeLines = result.context?.before || [];
      const afterLines = result.context?.after || [];
      for (const ctx of beforeLines.slice(-contextBefore || undefined)) {
        lines.push(formatContextLine(displayPath, showFilenames, showLineNumbers, ctx.lineNumber, ctx.lineText, "-"));
      }
      lines.push(formatContextLine(displayPath, showFilenames, showLineNumbers, result.lineNumber, baseLine, ":"));
      for (const ctx of afterLines.slice(0, contextAfter || undefined)) {
        lines.push(formatContextLine(displayPath, showFilenames, showLineNumbers, ctx.lineNumber, ctx.lineText, "-"));
      }
      lines.push("--");
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "--") lines.pop();

  return {
    stdout: lines.join("\n") + "\n",
    stderr: "",
    exitCode: 0,
  };
}

function getContextCount(flags: string[], shortFlag: string, longFlag: string): number {
  const shortIdx = flags.findIndex((f) => f === shortFlag);
  if (shortIdx >= 0 && flags[shortIdx + 1] && /^\d+$/.test(flags[shortIdx + 1]!)) {
    return Number(flags[shortIdx + 1]);
  }
  const longIdx = flags.findIndex((f) => f === longFlag);
  if (longIdx >= 0 && flags[longIdx + 1] && /^\d+$/.test(flags[longIdx + 1]!)) {
    return Number(flags[longIdx + 1]);
  }
  return 0;
}

function formatContextLine(
  displayPath: string,
  showFilenames: boolean,
  showLineNumbers: boolean,
  lineNumber: number,
  lineText: string,
  separator: string
): string {
  let output = "";
  if (showFilenames) output += `${displayPath}`;
  if (showLineNumbers) output += `${output ? ":" : ""}${lineNumber}`;
  if (output) output += separator;
  return `${output}${lineText}`;
}

/**
 * Hybrid search mode — RRF fusion of FTS + vector, output formatted like grep.
 */
async function executeHybridSearch(
  query: string,
  paths: string[],
  cwd: string,
  flags: string[]
): Promise<GrepResult> {
  try {
    const results = await searchHybrid(query, {
      limit: 20,
      filePaths: paths.length > 0 ? paths : undefined,
    });
    const lineResults = await selectBestLines(query, results);
    return formatSearchResults(lineResults, flags, { explicitPaths: paths.length > 0 });
  } catch (e: any) {
    return {
      stdout: "",
      stderr: `hybrid search error: ${e.message}`,
      exitCode: 2,
    };
  }
}
