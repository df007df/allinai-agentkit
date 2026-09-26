import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code's ask-user moment in headless (-p) runs is the permission
 * moment: a PermissionRequest hook receives the tool call when the platform
 * is about to ask the user for a decision, and its stdout reply is that
 * decision. Verified live (claude 2.1.278): under default mode the hook
 * fires on every would-prompt call (tool_name/tool_input in the payload);
 * under bypassPermissions it never fires at all; an empty reply means the
 * platform auto-denies; {"behavior":"allow"} passes the call through. The
 * daemon's HTTP approval bridge is the decision source — deny-only relay.
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
# Installed by allinai-agentkit: relay Claude Code permission requests
# (the headless ask-user moment) to the local daemon. The daemon's
# synchronous reply is the human decision; a decision to deny blocks,
# anything else allows. Allow must be explicit — an empty hook reply makes
# the platform auto-deny the call.
IN=$(cat)
RESP=$(curl -s --max-time 300 -X POST -H 'content-type: application/json' \\
  --data "{\\"platform\\":\\"claude\\",\\"payload\\":$IN}" \\
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
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"%s"}}}\\n' "$REASON"
else
  printf '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\\n'
fi
`;
}

export function claudeHooksSettingsFragment(
  scriptPath: string,
): Record<string, unknown> {
  return {
    hooks: {
      // PermissionRequest fires exactly when the platform is about to ask
      // for a permission decision — the only ask-user moment headless runs
      // have. NOTE: it never fires under bypassPermissions, so runs must
      // use the default permission mode and let hooks decide (allow by
      // default, deny only on a human decision).
      PermissionRequest: [
        {
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
    hooks: { PermissionRequest: Array<Record<string, unknown>> };
  };
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const permissionRequest = Array.isArray(hooks.PermissionRequest)
    ? hooks.PermissionRequest
    : [];
  const groups = permissionRequest as Array<{
    hooks?: Array<{ command?: string }>;
  }>;
  const already = groups.some((group) =>
    (group.hooks ?? []).some((hook) => hook.command === scriptPath),
  );
  let merged = existsSync(settingsPath);
  if (!already) {
    groups.push(desired.hooks.PermissionRequest[0]!);
  }
  hooks.PermissionRequest = groups;
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  return {
    settingsPath,
    scriptPath,
    merged,
    trustNote: CLAUDE_HOOKS_DOC_NOTE,
  };
}
