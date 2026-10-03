import assert from "node:assert/strict";
import { test } from "node:test";
import { runHubCli } from "./commands.js";

test("Hub web command reports both endpoints and closes on shutdown", async () => {
  let received: unknown;
  let closed = false;
  const result = await runHubCli(["web", "--port", "0", "--config-dir", "/tmp/test-hub", "--dev"], {
    write: () => {},
    startWeb: async (options) => {
      received = options;
      return { url: "http://127.0.0.1:4317", hubUrl: "ws://127.0.0.1:4317/_agentkit/hub/v2/ws", close: async () => { closed = true; } };
    },
    waitForShutdown: async () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(received, { port: 0, host: undefined, configDir: "/tmp/test-hub", dev: true });
  assert.deepEqual(JSON.parse(result.output[0]!), {
    consoleUrl: "http://127.0.0.1:4317", hubWsUrl: "ws://127.0.0.1:4317/_agentkit/hub/v2/ws",
  });
  assert.equal(closed, true);
});

test("Hub rejects invalid options before opening a server", async () => {
  for (const args of [
    ["web", "--port", "4317.5"], ["web", "--port", "65536"],
    ["web", "--port", "abc"], ["web", "--port"], ["web", "--host"],
    ["web", "--config-dir", "relative"], ["web", "--unknown"], ["daemon"],
  ]) {
    const result = await runHubCli(args, {
      write: () => {}, startWeb: async () => { assert.fail("invalid input started the server"); },
    });
    assert.equal(result.exitCode, 1, args.join(" "));
  }
});

test("Hub closes its server even when the shutdown waiter fails", async () => {
  let closed = false;
  const result = await runHubCli(["web"], {
    write: () => {},
    startWeb: async () => ({ url: "http://127.0.0.1:4317", hubUrl: "ws://127.0.0.1:4317/_agentkit/hub/v2/ws", close: async () => { closed = true; } }),
    waitForShutdown: async () => { throw new Error("shutdown failed"); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(closed, true);
});
