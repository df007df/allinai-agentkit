import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import { TokenRegistry } from "./token-registry.js";
import {
  handleConsoleLoginApprove,
  handleConsoleLoginDeny,
} from "./login-bridge.js";

const servers: http.Server[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    server.close();
    server.closeAllConnections();
    await once(server, "close").catch(() => undefined);
  }
});

type TestContext = { registry: TokenRegistry };

function startServer(
  route: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => Promise<void>,
): Promise<string> {
  const server = http.createServer((request, response) => {
    void route(request, response);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  });
}

function postJson(
  url: string,
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  return (async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      payload: (await response.json()) as Record<string, unknown>,
    };
  })();
}

describe("console login bridge", () => {
  it("approves loopback logins with a registered token", async () => {
    const context: TestContext = { registry: new TokenRegistry() };
    const url = await startServer((request, response) =>
      handleConsoleLoginApprove(context, request, response),
    );
    const { status, payload } = await postJson(url, {
      clientId: "login-client",
      state: "state-1",
      redirectUri: "http://127.0.0.1:49152/callback",
    });
    assert.equal(status, 200);
    const target = new URL(payload.redirectUrl as string);
    assert.equal(target.host, "127.0.0.1:49152");
    assert.equal(target.searchParams.get("state"), "state-1");
    const token = target.searchParams.get("token") ?? "";
    assert.match(token, /^console-/);
    assert.equal(context.registry.verify(token)?.clientId, "login-client");
  });

  it("denies and rejects non-loopback redirect targets", async () => {
    const context: TestContext = { registry: new TokenRegistry() };
    const denyUrl = await startServer(handleConsoleLoginDeny);
    const { status, payload } = await postJson(denyUrl, {
      state: "state-2",
      redirectUri: "http://127.0.0.1:49152/callback",
    });
    assert.equal(status, 200);
    assert.match(payload.redirectUrl as string, /error=access_denied/);

    const approveUrl = await startServer((request, response) =>
      handleConsoleLoginApprove(context, request, response),
    );
    const evil = await postJson(approveUrl, {
      clientId: "evil",
      state: "state-3",
      redirectUri: "http://evil.example/callback",
    });
    assert.equal(evil.status, 400);
    assert.deepEqual(evil.payload, { error: "invalid_login_request" });
  });
});
