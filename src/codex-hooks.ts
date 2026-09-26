import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Codex has no SDK approval callback, so in-flight tool gating for Codex
 * ships as lifecycle hooks: a PreToolUse hook posts the tool call to the
 * local daemon control endpoint and lets its synchronous reply decide. The
 * decision JSON uses the legacy `{decision}` shape — Codex 0.155.0-alpha
 * marks the newer `hookSpecificOutput.permissionDecision` shape as a failed
 * hook run even though it honours the decision.
 */

export const CODEX_HOOKS_DOC_NOTE =
  "Run `codex` once and run /hooks to review and trust the installed hook; " +
  "untrusted hooks are skipped until trusted (recorded against the hook " +
  "definition hash).";

export type CodexHooksInstallInput = {
  /** Daemon control endpoint base, e.g. http://127.0.0.1:8787. */
  controlEndpoint: string;
  /** Codex home; defaults to ~/.codex. Injectable for tests. */
  codexHome?: string;
};

export type CodexHooksInstallResult = {
  hooksPath: string;
  scriptPath: string;
  /** True when an existing hooks.json was merged instead of created. */
  merged: boolean;
  trustNote: string;
};

export function codexHookScriptSource(controlEndpoint: string): string {
  return `#!/bin/bash
# Installed by allinai-agentkit: relay Codex tool-approval requests
# (tool ask-user) to the local daemon. The daemon's synchronous reply is
# the human decision; a decision to deny blocks, anything else (including
# an unreachable daemon) leaves the platform's own flow unchanged.
IN=$(cat)
RESP=$(curl -s --max-time 300 -X POST -H 'content-type: application/json' \\
  --data "{\\"platform\\":\\"codex\\",\\"payload\\":$IN}" \\
  ${controlEndpoint}/control/tool-approval)
DEC=$(printf '%s' "$RESP" | python3 -c "import json,sys;
try:
  d=json.load(sys.stdin); print(d.get('decision',''))
except Exception:
  print('')" 2>/dev/null)
REASON=$(printf '%s' "$RESP" | python3 -c "import json,sys;
try:
  print(json.load(sys.stdin).get('reason','denied by agentkit'))
except Exception:
  print('')" 2>/dev/null)
if [ "$DEC" = "deny" ]; then
  printf '{"decision":"block","reason":"%s"}\\n' "$REASON"
else
  echo '{}'
fi
`;
}

export function codexHooksJsonSource(scriptPath: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        // pre_tool_use is Codex's tool-gating hook: this is where a tool
        // approval decision (ask-user) is relayed to the daemon.
        PreToolUse: [
          {
            hooks: [{ type: "command", command: scriptPath, timeout: 300 }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export function installCodexHooks(
  input: CodexHooksInstallInput,
): CodexHooksInstallResult {
  const codexHome = input.codexHome ?? join(homedir(), ".codex");
  mkdirSync(codexHome, { recursive: true });
  const agentkitDir = join(codexHome, "agentkit");
  mkdirSync(agentkitDir, { recursive: true });

  const scriptPath = join(agentkitDir, "pre-tool-use.sh");
  writeFileSync(scriptPath, codexHookScriptSource(input.controlEndpoint), {
    mode: 0o755,
  });

  const hooksPath = join(codexHome, "hooks.json");
  const desired = JSON.parse(codexHooksJsonSource(scriptPath)) as {
    hooks: { PreToolUse: Array<Record<string, unknown>> };
  };
  let merged = false;
  if (existsSync(hooksPath)) {
    const existing = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    existing.hooks = existing.hooks ?? {};
    const preToolUse = existing.hooks.PreToolUse;
    existing.hooks.PreToolUse = Array.isArray(preToolUse) ? preToolUse : [];
    const groups = existing.hooks.PreToolUse as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string }>;
    }>;
    const already = groups.some((group) =>
      (group.hooks ?? []).some((hook) => hook.command === scriptPath),
    );
    if (!already) {
      groups.push(desired.hooks.PreToolUse[0]);
    }
    merged = true;
    writeFileSync(hooksPath, `${JSON.stringify(existing, null, 2)}\n`);
  } else {
    writeFileSync(hooksPath, codexHooksJsonSource(scriptPath));
  }

  return {
    hooksPath,
    scriptPath,
    merged,
    trustNote: CODEX_HOOKS_DOC_NOTE,
  };
}
