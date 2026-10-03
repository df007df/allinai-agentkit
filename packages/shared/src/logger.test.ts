import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createRotatingJsonlLogger, serializeLog } from "./logger.js";

describe("agent JSONL logger", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes log entries verbatim, including credential-shaped values", () => {
    const line = serializeLog({
      token: "secret-token",
      message: "request rejected: Bearer secret-token",
      nested: { authorization: "Bearer another-secret" },
    });

    assert.match(line, /secret-token/);
    assert.match(line, /another-secret/);
    assert.doesNotMatch(line, /\[REDACTED\]/);
  });

  it("rotates before writing a line that would exceed the configured size", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-log-"));
    const logger = createRotatingJsonlLogger({
      logsRoot: dir,
      maxBytes: 90,
      maxFiles: 2,
    });

    await logger.write({ message: "one".repeat(20) });
    await logger.write({ message: "two".repeat(20) });

    assert.match(readFileSync(path.join(dir, "agent.log.1"), "utf8"), /one/);
    assert.match(readFileSync(path.join(dir, "agent.log"), "utf8"), /two/);
  });
});
