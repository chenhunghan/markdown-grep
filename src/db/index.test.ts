import { expect, test } from "bun:test";
import { enqueueEmbeddingRefresh, getEmbeddingJobState } from "./index.ts";

test("enqueueEmbeddingRefresh dedupes jobs by root and model", () => {
  const rootPath = "/tmp/mdg-test";
  const modelId = "model-a";

  enqueueEmbeddingRefresh({ rootPath, modelId });
  enqueueEmbeddingRefresh({ rootPath, modelId });

  const job = getEmbeddingJobState(rootPath, modelId);
  expect(job).not.toBeNull();
  expect(job?.requested_generation).toBeGreaterThanOrEqual(2);
});
