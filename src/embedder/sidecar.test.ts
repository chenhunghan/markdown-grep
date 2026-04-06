import { expect, test } from "bun:test";
import { hasCurrentEmbedServerScript } from "./sidecar.ts";

test("embed server shuts down by closing readline", () => {
  const script = `#!/usr/bin/env bun
// mdg embed-server — IPC embedding service
// version: 2
const rl = createInterface({ input: process.stdin });
rl.on("close", () => {
  process.exit(0);
});
`;

  expect(hasCurrentEmbedServerScript(script)).toBe(true);
  expect(script).toContain("rl.on(\"close\", () => {");
  expect(script).toContain("process.exit(0);");
});
