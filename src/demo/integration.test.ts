import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WsClientTransport } from "../client/index.js";
import { createCredentialStore } from "../credentials.js";
import { runLoginFlow } from "../login.js";
import type { InventoryReport } from "../protocol/index.js";
import { resolveAgentPathsAt } from "../paths.js";
import { startDemoSite } from "./index.js";

const report = {
  type: "inventory.report" as const,
  reportedAt: "2026-09-19T00:00:00.000Z",
  platforms: [],
  plugins: [],
};

const fullReport: InventoryReport = {
  type: "inventory.report" as const,
  reportedAt: "2026-09-19T01:02:03.000Z",
  platforms: [
    { platform: "codex", installed: true, version: "1.2.3" },
    { platform: "claude", installed: false, version: null, reason: "cli not found" },
  ],
  plugins: [
    {
      id: "search",
      gitUrl: "https://example.com/org/search.git",
      enabled: true,
      status: "active" as const,
      resolvedCommit: "a".repeat(40),
      installedAt: "2026-09-19T01:00:00.000Z",
    },
    {
      id: "broken",
      gitUrl: "https://example.com/org/broken.git",
      ref: "main",
      enabled: false,
      status: "failed" as const,
      resolvedCommit: "unresolved",
      installedAt: "2026-09-19T01:00:00.000Z",
      lastError: "clone failed",
    },
  ],
};

/** 走 demo 授权端点换一个 registry 已登记的 token（与浏览器授权同一路径）。 */
async function demoToken(site: { url: string }, clientId: string): Promise<string> {
  const approve = await fetch(`${site.url}/_agentkit/login/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId,
      state: "state-e2e",
      redirectUri: "http://127.0.0.1:49152/callback",
    }),
  });
  assert.equal(approve.status, 200);
  const payload = (await approve.json()) as { redirectUrl: string };
  const token = new URL(payload.redirectUrl).searchParams.get("token") ?? "";
  assert.match(token, /^demo-/);
  return token;
}

describe("demo site end-to-end", () => {
  it("login issues a token that a real client uses to receive offers", async () => {
    const site = await startDemoSite({ port: 0 });
    const home = mkdtempSync(path.join(tmpdir(), "agent-e2e-"));
    const credentials = createCredentialStore({
      paths: resolveAgentPathsAt(home),
    });
    let received: unknown = null;

    const login = await runLoginFlow({
      hubBaseUrl: site.url,
      clientId: "e2e-client",
      credentials,
      saveConfig: async () => {},
      open: async (url) => {
        const authorize = new URL(url);
        const approve = await fetch(`${site.url}/_agentkit/login/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: authorize.searchParams.get("client_id") ?? "",
            state: authorize.searchParams.get("state") ?? "",
            redirectUri: authorize.searchParams.get("redirect_uri") ?? "",
          }),
        });
        const payload = (await approve.json()) as { redirectUrl: string };
        await fetch(payload.redirectUrl); // 命中 CLI 的 loopback 回调
      },
      timeoutMs: 5_000,
    });
    assert.equal(await credentials.load("e2e-client"), login.token);

    // 先开 SSE 再接入 client：观测只广播给在线订阅者。
    const sse = await fetch(`${site.url}/_agentkit/console/observe`);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        seen += decoder.decode(chunk.value);
      }
    })();

    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: login.token,
      clientId: "e2e-client",
    });
    try {
      await transport.connect({
        command: async (command) => {
          received = command;
        },
        connected: async () => {},
      });

      let offered = await fetch(`${site.url}/_agentkit/console/offers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "e2e-client",
          prompt: "端到端验证",
        }),
      });
      const registerDeadline = Date.now() + 2_000;
      while (offered.status === 404 && Date.now() < registerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        offered = await fetch(`${site.url}/_agentkit/console/offers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            clientId: "e2e-client",
            prompt: "端到端验证",
          }),
        });
      }
      assert.equal(offered.status, 200);

      const deadline = Date.now() + 2_000;
      while (!received && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((received as { kind: string } | null)?.kind, "agent.run");

      // 触发一次 inventory.query；client 回报后观测流应出现 inventory 记录。
      const queried = await fetch(`${site.url}/_agentkit/console/inventory/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "e2e-client" }),
      });
      assert.equal(queried.status, 200);
      await transport.reportInventory?.(report);

      const seenDeadline = Date.now() + 2_000;
      while (
        !seen.includes("client.registered") ||
        !seen.includes("offer.enqueued") ||
        !seen.includes("inventory.recorded")
      ) {
        assert.ok(Date.now() < seenDeadline, "timed out waiting for sse events");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(seen, /event: snapshot/);
      assert.match(seen, /"clientId":"e2e-client"/);
      await reader.cancel();
      await pump.catch(() => undefined);
    } finally {
      await transport.close();
      await site.close();
    }
  });

  it("inventory query delivers a downlink and the recorded report reads back in full", async () => {
    const site = await startDemoSite({ port: 0 });
    let sync: { revision: string; inventoryQuery: boolean } | null = null;
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: await demoToken(site, "e2e-inventory"),
      clientId: "e2e-inventory",
    });
    try {
      await transport.connect({
        command: async () => {},
        connected: async () => {},
        pluginSync: async (input) => {
          sync = input;
        },
      });

      // 注册落地前 query 可能 404，短暂重试。
      let queried = await fetch(`${site.url}/_agentkit/console/inventory/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "e2e-inventory" }),
      });
      const registerDeadline = Date.now() + 2_000;
      while (queried.status === 404 && Date.now() < registerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        queried = await fetch(`${site.url}/_agentkit/console/inventory/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "e2e-inventory" }),
        });
      }
      assert.equal(queried.status, 200);
      assert.deepEqual(await queried.json(), { delivered: true });

      // 查询专用的 plugin.sync 下行必须带 inventoryQuery: true。
      const syncDeadline = Date.now() + 2_000;
      while (!sync && Date.now() < syncDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(sync);
      assert.equal(sync.inventoryQuery, true);

      // client 经真实上行回报清单 → hub 落库 → GET 读回完整字段。
      await transport.reportInventory(fullReport);

      const get = () => fetch(`${site.url}/_agentkit/console/inventory/e2e-inventory`);
      let got = await get();
      const reportDeadline = Date.now() + 2_000;
      while (got.status !== 200 && Date.now() < reportDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        got = await get();
      }
      assert.equal(got.status, 200);
      assert.deepEqual(await got.json(), fullReport);
    } finally {
      await transport.close();
      await site.close();
    }
  });
});
