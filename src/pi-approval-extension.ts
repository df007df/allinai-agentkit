import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Pi has no file-level hooks; its extension system is the equivalent
 * delivery surface. An extension placed in ~/.pi/agent/extensions/ is
 * auto-discovered on every session start and can block tool calls through
 * the `tool_call` event (`{ block: true, reason }`). The blocking decision
 * is fetched from the daemon's HTTP approval bridge — the same fail-closed
 * endpoint codex-hooks and claude-hooks use.
 */

export const PI_APPROVAL_DOC_NOTE =
  "The extension is auto-discovered on the next `pi` session start " +
  "(/reload reloads it in a running session).";

export type PiApprovalExtensionInstallInput = {
  /** Daemon control endpoint base, e.g. http://127.0.0.1:8787. */
  controlEndpoint: string;
  /** Pi agent dir; defaults to ~/.pi/agent. Injectable for tests. */
  piAgentDir?: string;
};

export type PiApprovalExtensionInstallResult = {
  extensionPath: string;
  /** True when an existing extension file with the same name was replaced. */
  replaced: boolean;
  note: string;
};

export function piApprovalExtensionSource(
  controlEndpoint: string,
): string {
  return `// Installed by allinai-agentkit: gate Pi tool calls on the local daemon.
// The daemon's synchronous reply (allow/deny) is the human decision.
const CONTROL_ENDPOINT = ${JSON.stringify(controlEndpoint)};

export default function agentkitToolApproval(pi) {
  pi.on("tool_call", async (event) => {
    const toolName = event?.toolName ?? "unknown";
    // High-risk tools only: shell commands and file mutations.
    const highRisk = /^(bash|edit|write|apply_patch|read_bash)/i.test(toolName);
    if (!highRisk) return;

    try {
      const response = await fetch(
        \`\${CONTROL_ENDPOINT}/control/tool-approval\`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            platform: "pi",
            payload: { toolName, input: event?.input ?? {} },
          }),
          signal: AbortSignal.timeout(300_000),
        },
      );
      const decision = (await response.json()) as {
        decision?: string;
        reason?: string;
      };
      if (decision.decision === "allow") return;
      return {
        block: true,
        reason: decision.reason ?? "denied by agentkit",
      };
    } catch {
      // Fail closed: an unreachable bridge must not silently allow.
      return { block: true, reason: "approval endpoint unreachable" };
    }
  });
}
`;
}

export function installPiApprovalExtension(
  input: PiApprovalExtensionInstallInput,
): PiApprovalExtensionInstallResult {
  const agentDir = input.piAgentDir ?? join(homedir(), ".pi", "agent");
  const extensionsDir = join(agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });

  const extensionPath = join(extensionsDir, "agentkit-tool-approval.ts");
  const replaced = existsSync(extensionPath);
  writeFileSync(extensionPath, piApprovalExtensionSource(input.controlEndpoint));

  return {
    extensionPath,
    replaced,
    note: PI_APPROVAL_DOC_NOTE,
  };
}

/** Reads back the installed extension's control endpoint (probe helper). */
export function readPiApprovalExtensionEndpoint(
  piAgentDir: string,
): string | null {
  const extensionPath = join(piAgentDir, "extensions", "agentkit-tool-approval.ts");
  if (!existsSync(extensionPath)) return null;
  const match = /const CONTROL_ENDPOINT = "([^"]+)"/.exec(
    readFileSync(extensionPath, "utf8"),
  );
  return match?.[1] ?? null;
}
