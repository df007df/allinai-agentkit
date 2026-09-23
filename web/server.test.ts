import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { test } from "node:test";
import {
  createAgentkitFallback,
  createAgentkitUpgradeHandler,
  startWebHost,
} from "./server.js";

const res = (): ServerResponse => {
  const chunks: string[] = [];
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    headersSent: false,
    writeHead(code: number, headers: object) {
      Object.assign(this, { statusCode: code, headers });
      return this;
    },
    end(body?: string) {
      this.headersSent = true;
      chunks.push(body ?? "");
      emitter.emit("finish");
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

test("non-hub upgrades (Next HMR) are forwarded to the app's upgrade handler", async () => {
  const forwarded: string[] = [];
  const handler = createAgentkitUpgradeHandler({
    nextUpgradeHandler: async (request) => {
      forwarded.push(request.url ?? "");
    },
  });
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  handler({ url: "/_next/webpack-hmr" } as never, socket as never, Buffer.alloc(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(forwarded, ["/_next/webpack-hmr"]);
  assert.equal(socket.destroyed, false, "a successful handoff must not destroy the socket");
});

test("a rejecting next upgrade handler destroys the socket instead of throwing", async () => {
  const handler = createAgentkitUpgradeHandler({
    nextUpgradeHandler: async () => {
      throw new Error("boom");
    },
  });
  const socket = { destroyed: false, destroy() { this.destroyed = true; } };
  handler({ url: "/_next/webpack-hmr" } as never, socket as never, Buffer.alloc(0));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.destroyed, true);
});

test("GET /_agentkit/login passes through to Next for the authorize page", async () => {
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
  fallback({ url: "/_agentkit/login?client_id=c&state=s", method: "GET" } as never, res());
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nextHit, true);
  assert.equal(routerHit, false);
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

test("non-loopback host arms hostWarning so write endpoints answer 403", async () => {
  // Binding a real non-loopback address would need network setup; asserting
  // runtime.stream.hostWarning directly keeps this cheap while covering the
  // arming logic startWebHost mirrors from startConsoleServer.
  const site = await startWebHost({ port: 0, dev: false, host: "0.0.0.0" });
  try {
    assert.ok(
      site.runtime.stream.hostWarning?.includes("0.0.0.0"),
      `non-loopback host must arm hostWarning, got: ${site.runtime.stream.hostWarning}`,
    );
    const denied = await fetch(`${site.url}/_agentkit/login/approve`, {
      method: "POST",
    });
    assert.equal(denied.status, 403);
    assert.deepEqual((await denied.json()) as Record<string, unknown>, {
      error: "loopback_only",
    });
  } finally {
    await site.close();
  }
});

test("close() settles while an SSE subscriber is attached", async () => {
  const site = await startWebHost({ port: 0, dev: false });
  const response = await fetch(`${site.url}/_agentkit/console/observe`);
  assert.equal(response.status, 200);
  // Hold the stream open (a backgrounded mobile client); close must still
  // finish rather than hang on the live subscriber socket.
  const closing = site.close();
  const finished = await Promise.race([
    closing.then(() => "closed" as const),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("close() hung with a live SSE subscriber")),
        5_000,
      ),
    ),
  ]);
  assert.equal(finished, "closed");
});
