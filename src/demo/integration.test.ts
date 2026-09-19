import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WsClientTransport } from "../client/index.js";
import { createCredentialStore } from "../credentials.js";
import { runLoginFlow } from "../login.js";
import { resolveAgentPathsAt } from "../paths.js";
import { startDemoSite } from "./index.js";

const report = {
  type: "inventory.report" as const,
  reportedAt: "2026-09-19T00:00:00.000Z",
  platforms: [],
  plugins: [],
};

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
        const approve = await fetch(`${site.url}/login/approve`, {
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
    const sse = await fetch(`${site.url}/api/demo/observe`);
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

      let offered = await fetch(`${site.url}/api/demo/offers`, {
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
        offered = await fetch(`${site.url}/api/demo/offers`, {
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
      const queried = await fetch(`${site.url}/api/demo/inventory/query`, {
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
});
