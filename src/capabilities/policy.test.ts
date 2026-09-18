import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideCapability, type CapabilityLocalPolicy } from "./policy.js";
import type { ShellCapability } from "./types.js";
import type { InstalledPlugin } from "../plugins/types.js";

const plugin: InstalledPlugin = {
  id: "demo.plugin",
  gitUrl: "https://github.com/allin-ai/demo-plugin.git",
  enabled: true,
  resolvedCommit: "a".repeat(40),
  installedAt: "2026-09-18T00:00:00.000Z",
  status: "active",
};

const networkCapability: ShellCapability = {
  id: "demo.publish",
  entry: "bin/publish.mjs",
  inputSchema: { type: "object" },
  contextKeys: ["execution", "workspace"],
  permissions: ["network"],
  timeoutSeconds: 30,
};

function policy(
  overrides: Partial<CapabilityLocalPolicy> = {},
): CapabilityLocalPolicy {
  return {
    clientEnabled: true,
    autoPermissions: [],
    allowedGitOrigins: ["github.com"],
    deniedPluginIds: [],
    allowedWorkspaceRoots: ["/workspace"],
    ...overrides,
  };
}

describe("shell capability local policy", () => {
  it("requires approval for a network capability not listed as automatic", () => {
    assert.deepEqual(
      decideCapability(
        policy({ autoPermissions: [] }),
        plugin,
        networkCapability,
        "/workspace/app",
      ),
      { mode: "approval", reason: "network requires local approval" },
    );
  });

  it("evaluates client, plugin, origin, and workspace constraints before permission rules", () => {
    assert.deepEqual(
      decideCapability(
        policy({
          clientEnabled: false,
          allowedGitOrigins: [],
          allowedWorkspaceRoots: [],
        }),
        { ...plugin, status: "blocked" },
        networkCapability,
        "/outside",
      ),
      { mode: "deny", reason: "client is disabled" },
    );
    assert.deepEqual(
      decideCapability(
        policy({ allowedGitOrigins: [], allowedWorkspaceRoots: [] }),
        { ...plugin, status: "blocked" },
        networkCapability,
        "/outside",
      ),
      { mode: "deny", reason: "plugin is not active" },
    );
    assert.deepEqual(
      decideCapability(
        policy({ allowedGitOrigins: [], allowedWorkspaceRoots: [] }),
        plugin,
        networkCapability,
        "/outside",
      ),
      { mode: "deny", reason: "plugin Git origin is not allowed" },
    );
    assert.deepEqual(
      decideCapability(policy(), plugin, networkCapability, "/outside"),
      { mode: "deny", reason: "workspace is not allowed" },
    );
  });

  it("only auto-runs when every requested permission is explicitly local-allowed", () => {
    const workspaceCapability: ShellCapability = {
      ...networkCapability,
      permissions: ["workspace:write"],
    };
    assert.deepEqual(
      decideCapability(
        policy({ autoPermissions: ["workspace:write"] }),
        plugin,
        workspaceCapability,
        "/workspace/app",
      ),
      {
        mode: "auto",
        reason: "all capability permissions are locally allowed",
      },
    );
    assert.deepEqual(
      decideCapability(
        policy({ autoPermissions: ["workspace:write"] }),
        plugin,
        { ...networkCapability, permissions: ["workspace:write", "network"] },
        "/workspace/app",
      ),
      { mode: "approval", reason: "network requires local approval" },
    );
  });
});
