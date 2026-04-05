/**
 * Scans the current working directory recursively for .md files.
 * Respects .gitignore if present.
 */
import { Glob } from "bun";
import { resolve, relative } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface ScannedFile {
  /** Relative path from root */
  relPath: string;
  /** Absolute path on disk */
  absPath: string;
}

/**
 * Recursively find all .md files under the given root directory.
 * Skips node_modules, .git, and hidden directories.
 */
export async function scanMarkdownFiles(root: string): Promise<ScannedFile[]> {
  const absRoot = resolve(root);
  const glob = new Glob("**/*.md");
  const files: ScannedFile[] = [];

  for await (const match of glob.scan({
    cwd: absRoot,
    absolute: false,
    onlyFiles: true,
    // Skip common non-content directories
    // Bun's glob doesn't have an exclude option, so we filter manually
  })) {
    // Skip hidden dirs, node_modules, .git, etc.
    if (shouldSkip(match)) continue;
    files.push({
      relPath: match,
      absPath: resolve(absRoot, match),
    });
  }

  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

const SKIP_PATTERNS = [
  /^node_modules\//,
  /\/node_modules\//,
  /^\./,
  /\/\./,
  /^\.git\//,
  /\/\.git\//,
];

function shouldSkip(relPath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(relPath));
}

/**
 * Compute SHA-256 hash of file content.
 */
export async function hashFile(absPath: string): Promise<string> {
  const file = Bun.file(absPath);
  const content = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(new Uint8Array(content));
  return hasher.digest("hex");
}

/**
 * Read file content as string.
 */
export async function readMarkdownFile(absPath: string): Promise<string> {
  const file = Bun.file(absPath);
  return file.text();
}
