import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export type AgentPaths = Readonly<{
  home: string;
  configFile: string;
  stateDb: string;
  credentialsRoot: string;
  pluginsRoot: string;
  runsRoot: string;
  logsRoot: string;
  controlSocket: string;
}>;

/** Resolve the one local root owned by an Agent Client installation. */
export function resolveAgentHome(homeDir = os.homedir()): string {
  return path.join(homeDir, ".allinai", "agent");
}

/**
 * Every filesystem path owned by the standalone client derives from one root.
 * Keeping this construction here makes accidental use of a host application's
 * data directory straightforward to spot in review.
 */
export function resolveAgentPaths(homeDir = os.homedir()): AgentPaths {
  return resolveAgentPathsAt(resolveAgentHome(homeDir));
}

/** Resolve every owned path when a host supplies an explicit Agent home. */
export function resolveAgentPathsAt(home: string): AgentPaths {
  if (!path.isAbsolute(home)) {
    throw new TypeError("Agent home must be an absolute path");
  }
  return {
    home,
    configFile: path.join(home, "config.json"),
    stateDb: path.join(home, "state.db"),
    credentialsRoot: path.join(home, "credentials"),
    pluginsRoot: path.join(home, "plugins"),
    runsRoot: path.join(home, "runs"),
    logsRoot: path.join(home, "logs"),
    controlSocket: path.join(home, "control.sock"),
  };
}

/**
 * Windows named pipes cannot be represented below an ordinary user directory.
 * Derive a stable, opaque name from the Agent home rather than opening TCP.
 */
export function resolveAgentControlEndpoint(
  paths: AgentPaths,
  platform = process.platform,
): string {
  if (platform !== "win32") return paths.controlSocket;
  const id = createHash("sha256").update(paths.home).digest("hex").slice(0, 24);
  return `\\\\.\\pipe\\allinai-agentkit-${id}`;
}

export function isMemoryHookProxyPath(pathname: string): boolean {
  return pathname.startsWith("/api/memory/hooks/");
}

/** Optional W4+ passthrough; not wired in smoke. */
export function isOptionalAgentProxyPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/automation/") ||
    pathname.startsWith("/api/skills/")
  );
}
