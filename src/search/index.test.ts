import { expect, test } from "bun:test";
import { searchHybrid } from "./index.ts";

test("hybrid search falls back to FTS when embeddings are cold", async () => {
  const calls: string[] = [];

  const results = await searchHybrid("query", {
    limit: 1,
    deps: {
      ensureVectorSearchReady: async () => {
        calls.push("ready");
        return 1;
      },
      searchFTS: () => {
        calls.push("fts");
        return [];
      },
      searchVector: async () => {
        calls.push("vector");
        return [];
      },
    },
  });

  expect(calls).toEqual(["fts"]);
  expect(results).toEqual([]);
});
