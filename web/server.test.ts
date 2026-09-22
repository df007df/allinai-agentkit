import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import { createAgentkitFallback, startWebHost } from "./server.js";

const res = (): ServerResponse => {
  const chunks: string[] = [];
  return Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead(code: number, headers: object) {
      Object.assign(this, { statusCode: code, headers });
      return this;
    },
    end(body?: string) {
      this.headersSent = true;
      chunks.push(body ?? "");
      this.emit("finish");
    },
  }) as unknown as ServerResponse;
};

test("agentkit-prefixed requests go to the console router, others to next", async () => {
  let routerHit = false;
  let nextHit = false;
  const fallback = createAgentkitFallback({
    router: async () => {
      routerHit = true;
      return true;
    },
    nextHandler: () => {
      nextHit = true;
    },
  });
  fallback({ url: "/_agentkit/console/observe" } as never, res());
  fallback({ url: "/login" } as never, res());
  fallback({ url: "/_agentkit" } as never, res());
  fallback({ url: "/_agentkitx/lookalike" } as never, res());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(routerHit, true);
  assert.equal(nextHit, true);
});

test("unhandled agentkit paths answer a JSON 404 from the fallback", async () => {
  const fallback = createAgentkitFallback({
    router: async () => false,
    nextHandler: () => {
      assert.fail("next must not see agentkit-prefixed traffic");
    },
  });
  const response = res();
  let finished = false;
  response.on("finish", () => {
    finished = true;
  });
  fallback({ url: "/_agentkit/missing" } as IncomingMessage, response);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(finished, true);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headersSent, true);
});

test("startWebHost reports a path-carrying hubUrl and closes cleanly", async () => {
  const site = await startWebHost({ port: 0, dev: false });
  try {
    assert.match(site.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(
      site.hubUrl,
      /^ws:\/\/127\.0\.0\.1:\d+\/_agentkit\/hub\/v2\/ws$/,
    );
    const response = await fetch(`${site.url}/_agentkit/console/observe`);
    assert.equal(response.status, 200);
    await response.body?.cancel();
  } finally {
    await site.close();
  }
});
