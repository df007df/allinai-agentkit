import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WsClientTransport } from "../client/index.js";
import { CONSOLE_PLUGINS_PATH } from "../routes.js";
import { startConsoleServer } from "./index.js";

/** Mints a registry token by registering the client directly on the runtime. */
function mintToken(
  site: { runtime: { registry: { register(clientId: string): { token: string } } } },
  clientId: string,
): string {
  return site.runtime.registry.register(clientId).token;
}

describe("console plugins endpoint (desired catalog)", () => {
  it("starts empty, upserts entries, and reports them via GET", async () => {
    const site = await startConsoleServer({ port: 0 });
    try {
      const empty = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`);
      assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { clients: [] });

      const add = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          action: "add",
          plugin: {
            id: "my-skills",
            gitUrl: "https://git.example.test/skills.git",
            ref: "refs/heads/main",
          },
        }),
      });
      assert.equal(add.status, 200);
      const added = (await add.json()) as {
        delivered: boolean;
        plugins: Array<{ id: string; gitUrl: string; ref?: string; enabled: boolean }>;
      };
      // No client is connected, so the push reports undelivered — but the
      // catalog entry persists for the next push.
      assert.equal(added.delivered, false);
      assert.deepEqual(added.plugins, [
        {
          id: "my-skills",
          gitUrl: "https://git.example.test/skills.git",
          ref: "refs/heads/main",
          enabled: true,
        },
      ]);

      const list = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}?clientId=c1`);
      const listed = (await list.json()) as {
        clients: Array<{ clientId: string; plugins: unknown[] }>;
      };
      assert.equal(listed.clients.length, 1);
      assert.equal(listed.clients[0]?.plugins.length, 1);
    } finally {
      await site.close();
    }
  });

  it("delivers the catalog to a connected client and remove drops the entry", async () => {
    const site = await startConsoleServer({ port: 0 });
    const token = mintToken(site, "c2");
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token,
      clientId: "c2",
    });
    try {
      const connected = new Promise<void>((resolve) => {
        void transport.connect({
          command: async () => {},
          connected: async () => resolve(),
        });
      });
      await connected;

      const add = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "c2",
          action: "add",
          plugin: { id: "demo", gitUrl: "https://git.example.test/d.git" },
        }),
      });
      assert.equal(add.status, 200);
      assert.equal(((await add.json()) as { delivered: boolean }).delivered, true);

      const remove = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c2", action: "remove", pluginId: "demo" }),
      });
      assert.equal(remove.status, 200);
      const removed = (await remove.json()) as {
        delivered: boolean;
        plugins: unknown[];
      };
      assert.equal(removed.delivered, true);
      assert.deepEqual(removed.plugins, []);
    } finally {
      await transport.close();
      await site.close();
    }
  });

  it("rejects malformed input with explicit errors", async () => {
    const site = await startConsoleServer({ port: 0 });
    try {
      const badId = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "c1",
          action: "add",
          plugin: { id: "Bad Id!", gitUrl: "https://x.test/g.git" },
        }),
      });
      assert.equal(badId.status, 400);
      assert.equal(((await badId.json()) as { error: string }).error, "invalid_plugin");

      const missingId = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c1", action: "remove" }),
      });
      assert.equal(missingId.status, 400);
      assert.equal(
        ((await missingId.json()) as { error: string }).error,
        "pluginId_required",
      );

      const badAction = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c1", action: "explode" }),
      });
      assert.equal(badAction.status, 400);
      assert.equal(
        ((await badAction.json()) as { error: string }).error,
        "invalid_action",
      );
    } finally {
      await site.close();
    }
  });

  it("push re-delivers the whole catalog without mutating it (offline retry)", async () => {
    const site = await startConsoleServer({ port: 0 });
    try {
      // Catalog built while offline (delivered=false both times).
      await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "c3",
          action: "add",
          plugin: { id: "a", gitUrl: "https://git.test/a.git" },
        }),
      });
      const push = await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "c3", action: "push" }),
      });
      assert.equal(push.status, 200);
      const pushed = (await push.json()) as {
        delivered: boolean;
        plugins: Array<{ id: string }>;
      };
      assert.equal(pushed.delivered, false);
      assert.deepEqual(
        pushed.plugins.map((plugin) => plugin.id),
        ["a"],
      );
    } finally {
      await site.close();
    }
  });

  it("levels a reconnecting client up to the current catalog automatically", async () => {
    const site = await startConsoleServer({ port: 0 });
    const token = mintToken(site, "c4");
      let syncedPlugins: Array<{ id: string }> = [];
    const transport = new WsClientTransport({
      hubBaseUrl: site.url,
      token,
      clientId: "c4",
    });
    try {
      // Catalog edited while no client is connected.
      await fetch(`${site.url}${CONSOLE_PLUGINS_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientId: "c4",
          action: "add",
          plugin: { id: "late", gitUrl: "https://git.test/late.git" },
        }),
      });

      // The client connects afterwards: the onClientRegistered hook must
      // push the pending catalog without any manual re-push. The transport
      // routes plugin.sync to the pluginSync handler, not the command one.
      const synced = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("no plugin.sync within 3s")),
          3_000,
        );
        void transport
          .connect({
            command: async () => {},
            pluginSync: async (sync) => {
              syncedPlugins = sync.plugins;
              clearTimeout(timeout);
              resolve();
            },
            connected: async () => {},
          })
          .catch((error) => {
            clearTimeout(timeout);
            reject(error);
          });
      });
      await synced;
      assert.deepEqual(
        syncedPlugins.map((plugin) => plugin.id),
        ["late"],
      );
    } finally {
      await transport.close();
      await site.close();
    }
  });
});
