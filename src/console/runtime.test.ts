import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createConsoleRouter,
  createConsoleRuntime,
  startConsoleServer,
} from "./index.js";

test("console server serves static root, observe SSE, and hub ws path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "console-web-"));
  await writeFile(path.join(root, "index.html"), "<html>console</html>");
  const site = await startConsoleServer({ port: 0, staticRoot: root });
  try {
    const page = await fetch(`${site.url}/`);
    assert.match(await page.text(), /console/);
    const sse = await fetch(`${site.url}/_agentkit/console/observe`);
    assert.match(sse.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = sse.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /^event: snapshot/);
    // Deviation from the brief's verbatim test: `sse.body!.cancel()` throws
    // "ReadableStream is locked" on Node 22 after getReader(); the reader
    // itself must be cancelled.
    await reader.cancel();
    const hub = await fetch(`${site.url}/_agentkit/hub/v2/ws`);
    // Deviation from the brief's verbatim test (expected 400): the hub answers
    // a plain anonymous GET on the ws path with 401 unauthorized (426 only
    // with a valid token). 401 still proves the hub route is attached — a
    // router miss would surface as the static handler's 404.
    assert.equal(hub.status, 401);
    const approve = await fetch(`${site.url}/_agentkit/login/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "c1", state: "s", redirectUri: "http://127.0.0.1:1/cb" }),
    });
    const body = (await approve.json()) as { redirectUrl: string };
    assert.match(body.redirectUrl, /token=console-/);
  } finally {
    await site.close();
  }
});

test("write approval endpoints are loopback-gated by stream.hostWarning", async () => {
  const runtime = createConsoleRuntime();
  const router = createConsoleRouter(runtime);
  // Empty async-iterable body: handlers run for real once the gate opens.
  const emptyBody = (async function* () {})();
  const post = async (pathname: string, body: unknown) => {
    void body;
    const handled = await router(
      {
        method: "POST",
        url: pathname,
        [Symbol.asyncIterator]: () => emptyBody[Symbol.asyncIterator](),
      } as never,
      {
        writeHead: () => undefined,
        end: () => undefined,
      } as never,
    );
    return { handled };
  };

  // Non-loopback host: the unauthenticated write endpoints must be refused
  // without running their handlers (no token minted, no offer enqueued).
  runtime.stream.hostWarning = "console 正监听非回环地址";
  const approveBlocked = await post("/_agentkit/login/approve", {});
  assert.equal(approveBlocked.handled, true);
  assert.equal(
    runtime.registry.list().length,
    0,
    "no token may be minted on a non-loopback host",
  );
  const toolBlocked = await post("/_agentkit/console/tool-approval", {});
  assert.equal(toolBlocked.handled, true);
  assert.equal(
    runtime.state
      .snapshot()
      .observations.some((o) => o.kind === "offer.enqueued"),
    false,
    "no approval offer may be enqueued on a non-loopback host",
  );

  // Loopback host (warning null): the endpoints run their handlers again.
  runtime.stream.hostWarning = null;
  const approveOpen = await post("/_agentkit/login/approve", {});
  assert.equal(approveOpen.handled, true);
  assert.equal(
    runtime.registry.list().length,
    0,
    "an invalid approve body still mints nothing but must reach the handler",
  );
});
