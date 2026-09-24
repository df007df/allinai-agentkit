import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleRuntime } from "./runtime.js";
import { CONSOLE_PRINCIPAL } from "./token-registry.js";
import type { InventoryReport } from "../protocol/index.js";
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

/**
 * Plugin divergence resolution from the console. "force" re-pushes the
 * client's last-known desired plugin state with updatePolicy "force": the
 * client switches to the target commit and discards tracked local edits.
 * "keep" asks the client to re-report its current state (inventory query) so
 * the divergence banner reflects a deliberate keep, not a stale report.
 */
export async function handleConsolePluginAction(
  runtime: ConsoleRuntime,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const action = body.action;
  const pluginId = typeof body.pluginId === "string" ? body.pluginId : "";
  if (!clientId || (action !== "force" && action !== "keep") || !pluginId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "invalid_plugin_action",
        required: ["clientId", "action (force|keep)", "pluginId"],
      }),
    );
    return;
  }

  const inventory = await runtime.hub.getInventory({
    principal: CONSOLE_PRINCIPAL,
    clientId,
  });
  const entry = inventory?.plugins.find((plugin) => plugin.id === pluginId);
  if (!entry) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ error: "unknown_plugin", pluginId, clientId }),
    );
    return;
  }

  if (action === "force") {
    const desired: PluginConfig = {
      id: entry.id,
      gitUrl: entry.gitUrl,
      ...(entry.ref ? { ref: entry.ref } : {}),
      updatePolicy: "force",
      enabled: true,
    };
    const delivered = await runtime.hub.syncPlugins({
      principal: CONSOLE_PRINCIPAL,
      targetClientId: clientId,
      revision: `console-force-${randomUUID()}`,
      plugins: [desired],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ action, pluginId, delivered }));
    return;
  }

  // "keep": refresh the client's inventory so the console shows the current
  // local state as the deliberate baseline.
  const delivered = await runtime.hub.syncPlugins({
    principal: CONSOLE_PRINCIPAL,
    targetClientId: clientId,
    revision: `console-keep-${randomUUID()}`,
    plugins: [],
    inventoryQuery: true,
  });
  const report: InventoryReport | null = await runtime.hub.getInventory({
    principal: CONSOLE_PRINCIPAL,
    clientId,
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ action, pluginId, delivered, report }));
}
