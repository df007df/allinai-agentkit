import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { startDemoSite } from "./index.js";

describe("demo site", () => {
  it("starts, authorizes bootstrap tokens and serves the landing page", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      assert.ok(site.url.startsWith("http://127.0.0.1:"));
      assert.ok(site.hubUrl.endsWith("/api/agent-hub/v2/ws"));
      assert.match(site.bootstrapToken, /^demo-/);

      const page = await fetch(`${site.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);

      const socket = new WebSocket(`${site.hubUrl}?token=${site.bootstrapToken}`);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "client.hello",
          protocolVersion: 2,
          clientId: "smoke-client",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(socket.readyState, WebSocket.OPEN);
      socket.close();
    } finally {
      await site.close();
    }
  });

  it("rejects unknown tokens and closes", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      const socket = new WebSocket(`${site.hubUrl}?token=bad-token`);
      // hub 在 HTTP 层以 401 拒绝升级：ws 客户端会先 emit 'error' 再以 1006
      // close，而 events.once 会在 error 时直接 reject，故手动观察 close code。
      const code = await new Promise<number>((resolve) => {
        socket.on("error", () => {});
        socket.on("close", (closeCode) => resolve(closeCode as number));
      });
      assert.ok(code === 1008 || code === 4001 || code === 1006);
    } finally {
      await site.close();
    }
  });
});

describe("demo observe endpoint", () => {
  it("streams a snapshot then incremental observations", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      const response = await fetch(`${site.url}/api/demo/observe`);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type") ?? "",
        /^text\/event-stream/,
      );
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      const pump = (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          seen += decoder.decode(chunk.value);
        }
      })();

      const socket = new WebSocket(`${site.hubUrl}?token=${site.bootstrapToken}`);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "client.hello",
          protocolVersion: 2,
          clientId: "sse-client",
        }),
      );

      const deadline = Date.now() + 2_000;
      while (
        !seen.includes("event: snapshot") ||
        !seen.includes("client.registered")
      ) {
        assert.ok(Date.now() < deadline, "timed out waiting for sse events");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await reader.cancel();
      await pump.catch(() => undefined);
      socket.close();
    } finally {
      await site.close();
    }
  });
});

describe("demo login routes", () => {
  it("approves loopback logins with a registered token", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      const response = await fetch(`${site.url}/login/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "login-client",
          state: "state-1",
          redirectUri: "http://127.0.0.1:49152/callback",
        }),
      });
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { redirectUrl: string };
      const target = new URL(payload.redirectUrl);
      assert.equal(target.host, "127.0.0.1:49152");
      assert.equal(target.searchParams.get("state"), "state-1");
      const token = target.searchParams.get("token") ?? "";
      assert.match(token, /^demo-/);
      assert.equal(site.registry.verify(token)?.clientId, "login-client");
    } finally {
      await site.close();
    }
  });

  it("denies and rejects non-loopback redirect targets", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      const denied = await fetch(`${site.url}/login/deny`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          state: "state-2",
          redirectUri: "http://127.0.0.1:49152/callback",
        }),
      });
      assert.equal(denied.status, 200);
      const payload = (await denied.json()) as { redirectUrl: string };
      assert.match(payload.redirectUrl, /error=access_denied/);

      const evil = await fetch(`${site.url}/login/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "evil",
          state: "state-3",
          redirectUri: "http://evil.example/callback",
        }),
      });
      assert.equal(evil.status, 400);
    } finally {
      await site.close();
    }
  });

  it("serves the authorization page at /login", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      const page = await fetch(
        `${site.url}/login?client_id=c&state=s&redirect_uri=${encodeURIComponent("http://127.0.0.1:1/callback")}`,
      );
      assert.equal(page.status, 200);
      assert.match(await page.text(), /授权接入请求/);
    } finally {
      await site.close();
    }
  });
});
