import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleRuntime } from "./runtime.js";
import { CONSOLE_PRINCIPAL } from "./token-registry.js";
import type { PluginConfig } from "../plugins/types.js";

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += chunk.toString("utf8");
  try {
    return raw ? (JSON.parse(raw) as unknown) as Record<string, unknown> : {};
  } catch {
    throw new Error("invalid JSON body");
  }
}

/** Bare-but-complete PluginConfig validation for console input. */
function parsePluginInput(value: unknown): PluginConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) ||
    typeof entry.gitUrl !== "string" ||
    entry.gitUrl.trim().length === 0
  ) {
    return null;
  }
  if (
    entry.ref !== undefined &&
    entry.ref !== null &&
    (typeof entry.ref !== "string" || entry.ref.trim().length === 0)
  ) {
    return null;
  }
  return {
    id: entry.id,
    gitUrl: entry.gitUrl.trim(),
    ...(entry.ref ? { ref: (entry.ref as string).trim() } : {}),
    enabled: entry.enabled !== false,
  };
}

/**
 * Desired plugin/skill catalog for one client. The hub is deliberately
 * stateless about desired plugins (every sync carries the full list), so the
 * console keeps its own in-memory catalog per client: GET returns it merged
 * with the client's reported install state, POST upserts entries and pushes
 * the resulting catalog to the client via plugin.sync.
 */
export async function handleConsolePlugins(
  runtime: ConsoleRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET") {
    const url = new URL(request.url ?? "/", "http://console.invalid");
    const clientId = url.searchParams.get("clientId") ?? "";
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(
      JSON.stringify(runtime.plugins.catalog(clientId || undefined)),
    );
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const action = body.action;
  if (!clientId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "clientId_required" }));
    return;
  }

  // add/update: upsert one entry; remove: drop by id. Both push the whole
  // resulting catalog so the client always converges to one consistent list.
  if (action === "add" || action === "update") {
    const plugin = parsePluginInput(body.plugin);
    if (!plugin) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: "invalid_plugin",
          required: { id: "lowercase slug", gitUrl: "https/ssh URL" },
        }),
      );
      return;
    }
    const result = await runtime.plugins.upsert(clientId, plugin);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }
  if (action === "remove") {
    const pluginId =
      typeof body.pluginId === "string" ? body.pluginId : "";
    if (!pluginId) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "pluginId_required" }));
      return;
    }
    const result = await runtime.plugins.remove(clientId, pluginId);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }
  if (action === "push") {
    // Re-push the current catalog without changing it (retry after offline).
    const result = await runtime.plugins.push(clientId);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      error: "invalid_action",
      allowed: ["add", "update", "remove", "push"],
    }),
  );
}

export type DesiredCatalogResult = {
  clientId: string;
  plugins: PluginConfig[];
  /** True when the plugin.sync downlink reached a connected client. */
  delivered: boolean;
};

export function createDesiredPluginCatalog(hub: ConsoleRuntime["hub"]) {
  /** clientId → desired plugins, in insertion order (re-upsert keeps position). */
  const catalog = new Map<string, PluginConfig[]>();

  function snapshot(clientId?: string): {
    clients: Array<{ clientId: string; plugins: PluginConfig[] }>;
  } {
    const clients = [...catalog.entries()]
      .filter(([id]) => !clientId || id === clientId)
      .map(([id, plugins]) => ({ clientId: id, plugins }));
    return { clients };
  }

  async function push(
    clientId: string,
    plugins: PluginConfig[],
  ): Promise<DesiredCatalogResult> {
    const { delivered } = await hub.syncPlugins({
      principal: CONSOLE_PRINCIPAL,
      targetClientId: clientId,
      revision: `console-catalog-${randomUUID()}`,
      plugins,
    });
    return { clientId, plugins, delivered };
  }

  return {
    catalog: snapshot,
    async upsert(
      clientId: string,
      plugin: PluginConfig,
    ): Promise<DesiredCatalogResult> {
      const plugins = catalog.get(clientId) ?? [];
      const existing = plugins.findIndex((entry) => entry.id === plugin.id);
      if (existing >= 0) plugins[existing] = plugin;
      else plugins.push(plugin);
      catalog.set(clientId, plugins);
      return push(clientId, [...plugins]);
    },
    async remove(
      clientId: string,
      pluginId: string,
    ): Promise<DesiredCatalogResult> {
      const plugins = (catalog.get(clientId) ?? []).filter(
        (entry) => entry.id !== pluginId,
      );
      catalog.set(clientId, plugins);
      return push(clientId, [...plugins]);
    },
    async push(clientId: string): Promise<DesiredCatalogResult> {
      return push(clientId, [...(catalog.get(clientId) ?? [])]);
    },
  };
}

export type DesiredPluginCatalog = ReturnType<
  typeof createDesiredPluginCatalog
>;
