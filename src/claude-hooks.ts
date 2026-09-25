import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code gates tools through the same hook protocol family as Codex:
 * a PreToolUse hook in the settings file receives the tool call JSON on
 * stdin and its stdout decision decides the call. The daemon's HTTP
 * approval bridge (shared with codex-hooks) is the decision source —
 * fail-closed replay of a human decision made in the console.
 */

export const CLAUDE_HOOKS_DOC_NOTE =
  "Hooks take effect on the next claude session; no separate trust step is " +
  "required (Claude Code trusts settings-file hooks by default).";

export type ClaudeHooksInstallInput = {
  /** Daemon control endpoint base, e.g. http://127.0.0.1:8787. */
  controlEndpoint: string;
  /** Claude config dir; defaults to ~/.claude. Injectable for tests. */
  claudeHome?: string;
};

export type ClaudeHooksInstallResult = {
  settingsPath: string;
  scriptPath: string;
  /** True when an existing settings.hooks.PreToolUse was merged. */
  merged: boolean;
  trustNote: string;
};

export function claudeHookScriptSource(controlEndpoint: string): string {
  return `#!/bin/bash
# Installed by allinai-agentkit: gate Claude Code tool calls on the local daemon.
# The daemon's synchronous reply (allow/deny) is the human decision.
IN=$(cat)
RESP=$(curl -s --max-time 300 -X POST -H 'content-type: application/json' \\
  --data "{\\"platform\\":\\"claude\\",\\"payload\\":$IN}" \\
  ${controlEndpoint}/control/tool-approval)
DEC=$(printf '%s' "$RESP" | python3 -c "import json,sys;
try:
  d=json.load(sys.stdin); print(d.get('decision','allow'))
except Exception:
  print('deny')" 2>/dev/null)
REASON=$(printf '%s' "$RESP" | python3 -c "import json,sys;
try:
  print(json.load(sys.stdin).get('reason','denied by agentkit'))
except Exception:
  print('approval endpoint unreachable')" 2>/dev/null)
if [ "$DEC" = "allow" ]; then
  echo '{}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "$REASON"
fi
`;
}

export function claudeHooksSettingsFragment(
  scriptPath: string,
): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|Edit|Write|NotebookEdit",
          hooks: [{ type: "command", command: scriptPath, timeout: 300 }],
        },
      ],
    },
  };
}

export function installClaudeHooks(
  input: ClaudeHooksInstallInput,
): ClaudeHooksInstallResult {
  const claudeHome = input.claudeHome ?? join(homedir(), ".claude");
  mkdirSync(claudeHome, { recursive: true });
  const agentkitDir = join(claudeHome, "agentkit");
  mkdirSync(agentkitDir, { recursive: true });

  const scriptPath = join(agentkitDir, "pre-tool-use.sh");
  writeFileSync(scriptPath, claudeHookScriptSource(input.controlEndpoint), {
    mode: 0o755,
  });

  const settingsPath = join(claudeHome, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  }
  const desired = claudeHooksSettingsFragment(scriptPath) as {
    hooks: { PreToolUse: Array<Record<string, unknown>> };
  };
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const preToolUse = Array.isArray(hooks.PreToolUse)
    ? hooks.PreToolUse
    : [];
  const groups = preToolUse as Array<{
    matcher?: string;
    hooks?: Array<{ command?: string }>;
  }>;
  const already = groups.some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === scriptPath),
  );
  let merged = existsSync(settingsPath);
  if (!already) {
    groups.push(desired.hooks.PreToolUse[0]!);
  }
  hooks.PreToolUse = groups;
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    settingsPath,
    scriptPath,
    merged,
    trustNote: CLAUDE_HOOKS_DOC_NOTE,
  };
}
