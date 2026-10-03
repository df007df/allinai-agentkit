import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENTKIT_ROOT_PREFIX,
  CONSOLE_PATH_PREFIX,
  CONSOLE_OBSERVE_PATH,
  RESERVED_AGENTKIT_SEGMENTS,
} from "./routes.js";

test("console paths live under the reserved umbrella prefix", () => {
  assert.equal(CONSOLE_PATH_PREFIX, "/_agentkit/console");
  assert.equal(CONSOLE_OBSERVE_PATH, "/_agentkit/console/observe");
  assert.ok(CONSOLE_PATH_PREFIX.startsWith(`${AGENTKIT_ROOT_PREFIX}/`));
});

test("reserved segments include console, not demo", () => {
  const segments: readonly string[] = RESERVED_AGENTKIT_SEGMENTS;
  assert.ok(segments.includes("console"));
  assert.ok(!segments.includes("demo"));
});
