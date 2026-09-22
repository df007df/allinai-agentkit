import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { WsClientTransport } from "../client/index.js";
import { createCredentialStore } from "../credentials.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { runLoginFlow } from "../login.js";
import type { ClientEvent } from "../protocol/index.js";
import { resolveAgentPathsAt } from "../paths.js";
import { CONSOLE_OBSERVE_PATH, LOGIN_APPROVE_PATH } from "../routes.js";
import { startConsoleServer } from "./index.js";

function executionEvents(count: number): ClientEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    executionId: "e2e-execution",
    eventSeq: index + 1,
    type: index === 0 ? ("received" as const) : ("running" as const),
    occurredAt: new Date(Date.UTC(2026, 8, 19, 0, 0, index)).toISOString(),
  }));
}

/** 走 console 授权端点换一个 registry 已登记的 token（与浏览器授权同一路径）。 */
async function approveToken(
  site: { url: string },
  body: { clientId: string; state: string; redirectUri: string },
): Promise<string> {
  const approve = await fetch(`${site.url}${LOGIN_APPROVE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(approve.status, 200);
  const payload = (await approve.json()) as { redirectUrl: string };
  const token = new URL(payload.redirectUrl).searchParams.get("token") ?? "";
  assert.match(token, /^console-/);
  return token;
}

describe("console server end-to-end", () => {
  it("login issues a token that a real client uses to push events", async () => {
    const store = new MemoryHubStore<string>();
    const site = await startConsoleServer({ port: 0, store });
    const home = mkdtempSync(path.join(tmpdir(), "agent-e2e-"));
    const credentials = createCredentialStore({
      paths: resolveAgentPathsAt(home),
    });
    let receivedWatermarks: Record<string, number> | null = null;

    const login = await runLoginFlow({
      hubBaseUrl: site.url,
      clientId: "e2e-client",
      credentials,
      saveConfig: async () => {},
      open: async (url) => {
        const authorize = new URL(url);
        await approveToken(site, {
          clientId: authorize.searchParams.get("client_id") ?? "",
          state: authorize.searchParams.get("state") ?? "",
          redirectUri: authorize.searchParams.get("redirect_uri") ?? "",
        }).then(async (token) => {
          await fetch(
            `${authorize.searchParams.get("redirect_uri")}?token=${encodeURIComponent(token)}&state=${encodeURIComponent(authorize.searchParams.get("state") ?? "")}`,
          ); // 命中 CLI 的 loopback 回调
        });
      },
      timeoutMs: 5_000,
    });
    assert.match(login.token, /^console-/);
    assert.equal(await credentials.load("e2e-client"), login.token);
    assert.equal(site.runtime.registry.verify(login.token)?.clientId, "e2e-client");

    // 先开 SSE 再接入 client：观测只广播给在线订阅者。
    const sse = await fetch(`${site.url}${CONSOLE_OBSERVE_PATH}`);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          seen += decoder.decode(chunk.value);
        }
      } catch {
        // site.close() 会销毁订阅连接，读取端随之终止。
      }
    })();

    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: login.token,
      clientId: "e2e-client",
    });
    try {
      const connected = new Promise<void>((resolve) => {
        void transport.connect({
          command: async () => {},
          connected: async () => resolve(),
        });
      });
      await connected;

      receivedWatermarks = await transport.push(executionEvents(2));
      assert.deepEqual(receivedWatermarks, { "e2e-execution": 2 });

      const seenDeadline = Date.now() + 2_000;
      while (!seen.includes("client.registered") || !seen.includes("events.ingested")) {
        assert.ok(Date.now() < seenDeadline, "timed out waiting for sse events");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.match(seen, /event: snapshot/);
      assert.match(seen, /"clientId":"e2e-client"/);
    } finally {
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
      await transport.close();
      await site.close();
    }
  });

  it("a registry token registers a client whose events flow into the console state", async () => {
    const store = new MemoryHubStore<string>();
    const site = await startConsoleServer({ port: 0, store });
    const record = site.runtime.registry.register("e2e-events");
    assert.match(record.token, /^console-/);
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token: record.token,
      clientId: "e2e-events",
    });
    try {
      await transport.connect({
        command: async () => {},
        connected: async () => {},
      });

      // 注册落地是异步的：短暂等待 console 状态看到该 client。
      const registerDeadline = Date.now() + 2_000;
      while (!site.runtime.state.hasClient("e2e-events") && Date.now() < registerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(site.runtime.state.hasClient("e2e-events"));

      // 事件上行 → hub 落库并回 ack 水位 → console 状态可读回完整事件。
      const watermarks = await transport.push(executionEvents(3));
      assert.deepEqual(watermarks, { "e2e-execution": 3 });

      const snapshotDeadline = Date.now() + 2_000;
      while (site.runtime.state.snapshot().events.length < 3 && Date.now() < snapshotDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const snapshot = site.runtime.state.snapshot();
      assert.equal(snapshot.events.length, 3);
      assert.deepEqual(
        snapshot.events.map((event) => event.eventSeq),
        [1, 2, 3],
      );
      assert.ok(
        snapshot.observations.some(
          (observation) =>
            observation.kind === "events.ingested" &&
            observation.clientId === "e2e-events",
        ),
      );
    } finally {
      await transport.close();
      await site.close();
    }
  });
});
