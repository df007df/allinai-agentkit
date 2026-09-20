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

  it("redacts bearer tokens from JSONL fields and messages", () => {
    const line = serializeLog({
      token: "secret-token",
      message: "request rejected: Bearer secret-token",
      nested: { authorization: "Bearer another-secret" },
    });

    assert.doesNotMatch(line, /secret-token/);
    assert.doesNotMatch(line, /another-secret/);
    assert.match(line, /\[REDACTED\]/);
  });

  it("redacts camelCase and snake_case credential labels in log text", () => {
    const line = serializeLog({
      message:
        "pairing failed accessToken=camel-secret access_token:snake-secret refreshToken=refresh-secret client_secret=client-secret apiKey=api-secret",
    });

    assert.doesNotMatch(
      line,
      /camel-secret|snake-secret|refresh-secret|client-secret|api-secret/,
    );
    assert.match(line, /accessToken=\[REDACTED\]/);
    assert.match(line, /access_token:\[REDACTED\]/);
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
