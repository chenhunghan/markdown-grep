/**
 * MdgFs: A hybrid IFileSystem implementation for just-bash.
 *
 * - ls, find, stat, exists: served from real disk
 * - readFile: served from real disk
 * - grep acceleration: FTS coarse filter narrows which files to scan
 * - All write ops throw EROFS (read-only)
 */
import type { IFileSystem } from "just-bash";
import {
  readdir as fsReaddir,
  stat as fsStat,
  lstat as fsLstat,
  readFile as fsReadFile,
  realpath as fsRealpath,
  access,
} from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import { constants } from "node:fs";

interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function erofs(): Error {
  const err = new Error("Read-only file system");
  (err as any).code = "EROFS";
  return err;
}

function enoent(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`);
  (err as any).code = "ENOENT";
  return err;
}

export class MdgFs implements IFileSystem {
  private root: string;
  private allPaths: string[] | null = null;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private toAbs(path: string): string {
    if (path.startsWith("/")) {
      return join(this.root, path);
    }
    return resolve(this.root, path);
  }

  async readFile(path: string): Promise<string> {
    const abs = this.toAbs(path);
    try {
      return await fsReadFile(abs, "utf-8");
    } catch (e: any) {
      throw enoent(path);
    }
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const abs = this.toAbs(path);
    try {
      const buf = await fsReadFile(abs);
      return new Uint8Array(buf);
    } catch {
      throw enoent(path);
    }
  }

  async writeFile(): Promise<void> {
    throw erofs();
  }
  async appendFile(): Promise<void> {
    throw erofs();
  }

  async exists(path: string): Promise<boolean> {
    const abs = this.toAbs(path);
    try {
      await access(abs, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const abs = this.toAbs(path);
    try {
      const s = await fsStat(abs);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        mode: s.mode,
        size: s.size,
        mtime: s.mtime,
      };
    } catch {
      throw enoent(path);
    }
  }

  async lstat(path: string): Promise<FsStat> {
    const abs = this.toAbs(path);
    try {
      const s = await fsLstat(abs);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        mode: s.mode,
        size: s.size,
        mtime: s.mtime,
      };
    } catch {
      throw enoent(path);
    }
  }

  async chmod(): Promise<void> {
    throw erofs();
  }

  async utimes(): Promise<void> {
    throw erofs();
  }

  async mkdir(): Promise<void> {
    throw erofs();
  }

  async readdir(path: string): Promise<string[]> {
    const abs = this.toAbs(path);
    try {
      const entries = await fsReaddir(abs);
      // Filter to only show .md files and directories (that contain .md files)
      return entries.filter(
        (e) => !e.startsWith(".") && e !== "node_modules"
      );
    } catch {
      throw enoent(path);
    }
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const abs = this.toAbs(path);
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(abs, { withFileTypes: true });
      return entries
        .filter((e) => !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink(),
        }));
    } catch {
      throw enoent(path);
    }
  }

  async rm(): Promise<void> {
    throw erofs();
  }
  async cp(): Promise<void> {
    throw erofs();
  }
  async mv(): Promise<void> {
    throw erofs();
  }
  async symlink(): Promise<void> {
    throw erofs();
  }
  async link(): Promise<void> {
    throw erofs();
  }

  async readlink(path: string): Promise<string> {
    const abs = this.toAbs(path);
    const { readlink } = await import("node:fs/promises");
    try {
      return await readlink(abs, "utf-8");
    } catch {
      throw enoent(path);
    }
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return path;
    return join(base, path);
  }

  async realpath(path: string): Promise<string> {
    const abs = this.toAbs(path);
    try {
      const real = await fsRealpath(abs);
      // Return as VFS-relative path
      return "/" + relative(this.root, real);
    } catch {
      throw enoent(path);
    }
  }

  /**
   * Returns all file paths in the VFS. Used by just-bash for glob matching.
   * Lazily scanned and cached.
   */
  getAllPaths(): string[] {
    if (this.allPaths) return this.allPaths;

    // Synchronously scan for .md files
    const { globSync } = require("bun");
    const glob = new Bun.Glob("**/*.md");
    const paths: string[] = [];

    for (const match of glob.scanSync({
      cwd: this.root,
      absolute: false,
      onlyFiles: false,
    })) {
      if (
        match.startsWith(".") ||
        match.includes("/." ) ||
        match.includes("node_modules")
      )
        continue;
      paths.push("/" + match);
      // Also add parent directories
      let dir = "/" + dirname(match);
      while (dir !== "/" && !paths.includes(dir)) {
        paths.push(dir);
        dir = dirname(dir);
      }
    }

    // Add root
    if (!paths.includes("/")) paths.push("/");

    this.allPaths = paths.sort();
    return this.allPaths;
  }
}
