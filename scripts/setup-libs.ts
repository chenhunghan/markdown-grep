#!/usr/bin/env bun
/**
 * Post-build script: copies native extensions to ~/.mdg/lib/
 * so the compiled binary can find them at runtime.
 */
import { mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { platform, arch } from "node:process";

const MDG_LIB = join(homedir(), ".mdg", "lib");

// Ensure target directory exists
mkdirSync(MDG_LIB, { recursive: true });

// Copy sqlite-vec native extension
const suffix = platform === "win32" ? "dll" : platform === "darwin" ? "dylib" : "so";
const os = platform === "win32" ? "windows" : platform;
const pkgName = `sqlite-vec-${os}-${arch}`;
const fileName = `vec0.${suffix}`;

const src = join(import.meta.dir, "..", "node_modules", pkgName, fileName);
const dest = join(MDG_LIB, fileName);

if (existsSync(src)) {
  copyFileSync(src, dest);
  console.log(`Copied ${fileName} → ${dest}`);
} else {
  console.warn(`Warning: ${src} not found. sqlite-vec features require this extension.`);
}

console.log("Setup complete. The mdg binary can now be moved anywhere.");
