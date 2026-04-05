import { expect, test } from "bun:test";
import { searchHybrid } from "./index.ts";

test("hybrid search initializes readiness before running search branches", async () => {
  const calls: string[] = [];

  await searchHybrid("query", {
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

  expect(calls).toEqual(["ready", "fts", "vector"]);
});
