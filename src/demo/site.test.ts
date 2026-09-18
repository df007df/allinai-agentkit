import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { WebSocket } from "ws";
import { WsClientTransport } from "../client/index.js";
import { startDemoSite } from "./index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";

type DemoSiteHandle = {
  url: string;
  hubUrl: string;
  registry: { verify(token: string): { clientId: string } | null };
};

/** 走真实 login approve 端点换一个已授权 token（纯浏览器授权模型）。 */
async function loginToken(
  site: DemoSiteHandle,
  clientId: string,
): Promise<string> {
  const response = await fetch(`${site.url}/login/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId,
      state: "state-smoke",
      redirectUri: "http://127.0.0.1:49152/callback",
    }),
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { redirectUrl: string };
  const token = new URL(payload.redirectUrl).searchParams.get("token") ?? "";
  assert.match(token, /^demo-/);
  return token;
}

describe("demo site", () => {
  it("starts, serves the landing page and authorizes login tokens", async () => {
    const site = await startDemoSite({ port: 0 });
    try {
      assert.ok(site.url.startsWith("http://127.0.0.1:"));
      assert.ok(site.hubUrl.endsWith("/api/agent-hub/v2/ws"));

      const page = await fetch(`${site.url}/`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /^text\/html/);

      const token = await loginToken(site, "smoke-client");
      const socket = new WebSocket(`${site.hubUrl}?token=${token}`);
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

      const socket = new WebSocket(
        `${site.hubUrl}?token=${await loginToken(site, "sse-client")}`,
      );
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

describe("demo offers endpoint", () => {
  it("delivers an agent.run offer to a connected client", async () => {
    const site = await startDemoSite({ port: 0 });
    let received: unknown = null;
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: await loginToken(site, "offer-client"),
      clientId: "offer-client",
    });
    try {
      await transport.connect({
        command: async (command) => {
          received = command;
        },
        connected: async () => {},
      });

      let response = await fetch(`${site.url}/api/demo/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "offer-client",
          prompt: "写一首关于秋天的诗",
        }),
      });
      // connect() 返回时服务端注册可能尚未落地，404 短暂重试。
      const registerDeadline = Date.now() + 2_000;
      while (response.status === 404 && Date.now() < registerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        response = await fetch(`${site.url}/api/demo/offers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "offer-client",
            prompt: "写一首关于秋天的诗",
          }),
        });
      }
      assert.equal(response.status, 200);
      const payload = (await response.json()) as { offerId: string };
      assert.match(payload.offerId, /.+/);

      const deadline = Date.now() + 2_000;
      while (!received && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(received);
      assert.equal(
        (received as { kind: string }).kind,
        "agent.run",
      );
      assert.equal(
        (received as { payload: { prompt: string } }).payload.prompt,
        "写一首关于秋天的诗",
      );

      const missing = await fetch(`${site.url}/api/demo/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "ghost", prompt: "x" }),
      });
      assert.equal(missing.status, 404);
    } finally {
      await transport.close();
      await site.close();
    }
  });
});

describe("custom hub store injection", () => {
  it("routes registrations through a caller-provided store", async () => {
    const registered: string[] = [];
    class RecordingStore extends MemoryHubStore<string> {
      override async registerClient(input: {
        clientId: string;
      }): Promise<{ clientId: string; connectionKey: string }> {
        registered.push(input.clientId);
        return await super.registerClient(
          input as Parameters<MemoryHubStore<string>["registerClient"]>[0],
        );
      }
    }
    const { startDemoSite } = await import("./index.js");
    const site = await startDemoSite({
      port: 0,
      store: new RecordingStore(),
    });
    try {
      const token = await loginToken(site, "custom-store-client");
      const socket = new WebSocket(`${site.hubUrl}?token=${token}`);
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "client.hello",
          protocolVersion: 2,
          clientId: "custom-store-client",
        }),
      );
      const deadline = Date.now() + 2_000;
      while (!registered.includes("custom-store-client") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepEqual(registered, ["custom-store-client"]);
      socket.close();
    } finally {
      await site.close();
    }
  });
});
