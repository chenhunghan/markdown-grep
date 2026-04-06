import { expect, test } from "bun:test";
import { searchHybrid, selectBestLines } from "./index.ts";

test("hybrid search falls back to FTS when embeddings are cold", async () => {
  const results = await searchHybrid("query", {
    limit: 1,
    deps: {
      searchFTS: () => {
        return [];
      },
      searchVector: async () => {
        return [];
      },
    },
  });

  expect(results).toEqual([]);
});

test("selectBestLines reduces a chunk to one line", async () => {
  const lines = await selectBestLines("Markdown Grep", [
    {
      filePath: "README.md",
      content: "# mdg — Markdown Grep\nGrep-like search over markdown files",
      startLine: 1,
      endLine: 2,
      score: 1,
      method: "hybrid",
    },
  ]);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.filePath).toBe("README.md");
  expect(lines[0]?.lineNumber).toBe(1);
  expect(lines[0]?.lineText).toContain("Markdown Grep");
  expect(lines[0]?.lineText).not.toContain("Grep-like search over markdown files");
});
