import path from "node:path";
import { isAllowedGitOrigin } from "../plugins/git.js";
import type { InstalledPlugin } from "../plugins/types.js";
import type {
  CapabilityPermission,
  PolicyDecision,
  ShellCapability,
} from "./types.js";

export type CapabilityLocalPolicy = {
  /** Explicitly false is a durable local kill-switch for all capabilities. */
  clientEnabled: boolean;
  autoPermissions: readonly CapabilityPermission[];
  allowedGitOrigins: readonly string[];
  deniedPluginIds: readonly string[];
  allowedWorkspaceRoots: readonly string[];
};

function isWorkspaceAllowed(
  workspace: string,
  roots: readonly string[],
): boolean {
  if (!path.isAbsolute(workspace) || roots.length === 0) return false;
  const resolvedWorkspace = path.resolve(workspace);
  return roots.some((root) => {
    if (typeof root !== "string" || !path.isAbsolute(root)) return false;
    const relative = path.relative(path.resolve(root), resolvedWorkspace);
    return (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." &&
        !path.isAbsolute(relative))
    );
  });
}

function permissionApprovalReason(permission: CapabilityPermission): string {
  return permission === "network"
    ? "network requires local approval"
    : "workspace:write requires local approval";
}

/**
 * Policy order is deliberately fixed: coarse local safety constraints are
 * never weakened by a later auto-permission setting. Unknown configuration
 * and empty allowlists therefore fail closed.
 */
export function decideCapability(
  policy: CapabilityLocalPolicy,
  plugin: InstalledPlugin,
  capability: ShellCapability,
  workspace: string,
): PolicyDecision {
  if (!policy.clientEnabled)
    return { mode: "deny", reason: "client is disabled" };
  if (plugin.status !== "active" || !plugin.enabled) {
    return { mode: "deny", reason: "plugin is not active" };
  }
  if (policy.deniedPluginIds.includes(plugin.id)) {
    return { mode: "deny", reason: "plugin is denied by local policy" };
  }
  if (!isAllowedGitOrigin(plugin.gitUrl, policy.allowedGitOrigins)) {
    return { mode: "deny", reason: "plugin Git origin is not allowed" };
  }
  if (!isWorkspaceAllowed(workspace, policy.allowedWorkspaceRoots)) {
    return { mode: "deny", reason: "workspace is not allowed" };
  }

  const automatic = new Set(policy.autoPermissions);
  // Network always asks unless this exact permission appears in local policy.
  if (capability.permissions.includes("network") && !automatic.has("network")) {
    return { mode: "approval", reason: permissionApprovalReason("network") };
  }
  for (const permission of capability.permissions) {
    if (!automatic.has(permission)) {
      return { mode: "approval", reason: permissionApprovalReason(permission) };
    }
  }
  return {
    mode: "auto",
    reason: "all capability permissions are locally allowed",
  };
}
