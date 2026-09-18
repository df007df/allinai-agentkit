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
