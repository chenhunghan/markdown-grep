import { expect, test } from "bun:test";
import { executeGrep, formatSearchResults } from "./grep.ts";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const cwd = "/Users/chh/mdg";
const fixtureRoot = "/tmp/mdg-grep-golden";

function setupFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(join(fixtureRoot, "sub"), { recursive: true });
  writeFileSync(join(fixtureRoot, "README.md"), "# UniqueRecPrefixToken\nsecond line\nthird line\n");
  writeFileSync(join(fixtureRoot, "sub", "nested.md"), "prefix\nUniqueRecPrefixToken\ncontext line\n");
}

test("exact grep output matches plain grep paths for explicit files", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: ["README.md", "CHANGELOG.md"],
    flags: ["-rn"],
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(
    "README.md:1:# mdg — Markdown Grep\n" +
      "CHANGELOG.md:8:* initial implementation of mdg (Markdown Grep) ([1b04d97](https://github.com/chenhunghan/mdg/commit/1b04d970ebdaeda53c27bd0cfdf3c0e856657069))\n"
  );
});

test("exact grep output uses dot-prefixed paths for cwd searches", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: [],
    flags: ["-rn"],
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("./README.md:1:# mdg — Markdown Grep");
});

test("-e patterns are not duplicated into the shell command", async () => {
  const result = await executeGrep({
    pattern: "Markdown Grep",
    paths: ["README.md"],
    flags: ["-e"],
    patternFromFlag: true,
    cwd,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("# mdg — Markdown Grep\n");
});

test("hybrid formatter uses grep-like filenames without slashes", () => {
  const result = formatSearchResults(
    [
      {
        filePath: "README.md",
        lineNumber: 1,
        lineText: "# mdg — Markdown Grep",
        score: 1,
        method: "vector",
        context: { before: [], after: [] },
      },
    ],
    ["-n"],
    { explicitPaths: true }
  );

  expect(result.stdout).toBe("1:# mdg — Markdown Grep\n");
});

test("recursive default path prefix matches grep", async () => {
  setupFixture();
  const native = Bun.spawnSync(["grep", "-rn", "UniqueRecPrefixToken", "."], { cwd: fixtureRoot });
  const mdg = await executeGrep({ pattern: "UniqueRecPrefixToken", paths: [], flags: ["-rn"], cwd: fixtureRoot, hybrid: false });
  expect(mdg.stdout).toBe(native.stdout.toString());
});

test("count mode matches grep", async () => {
  setupFixture();
  const native = Bun.spawnSync(["grep", "-c", "Markdown Grep", "README.md"], { cwd: fixtureRoot });
  const mdg = await executeGrep({ pattern: "Markdown Grep", paths: ["README.md"], flags: ["-c"], cwd: fixtureRoot });
  expect(mdg.stdout).toBe(native.stdout.toString());
});

test("context mode matches grep", async () => {
  setupFixture();
  const native = Bun.spawnSync(["grep", "-A1", "Markdown Grep", "README.md"], { cwd: fixtureRoot });
  const mdg = await executeGrep({ pattern: "Markdown Grep", paths: ["README.md"], flags: ["-A1"], cwd: fixtureRoot });
  expect(mdg.stdout).toBe(native.stdout.toString());
});
