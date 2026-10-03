import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Codex trusts a hooks.json entry only after a human confirms it in the
 * TUI; the confirmation is recorded as the script's sha256 in
 * config.toml `[hooks.state."<hooks.json path>:<event>:<i>:<j>"]`. An
 * installed-but-untrusted hook is silently skipped by Codex — the
 * approval gate would be open without anyone noticing. This probe makes
 * that state visible so the daemon can report pending_trust upstream.
 */

export type CodexHookTrustStatus = {
  /** The hook script is registered in hooks.json. */
  installed: boolean;
  /** The installed script's content hash matches a trusted record. */
  trusted: boolean;
  scriptPath: string;
  hooksPath: string;
};

function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function readCodexHookTrustStatus(
  input: {
    scriptPath?: string;
    codexHome?: string;
  } = {},
): CodexHookTrustStatus {
  const codexHome = input.codexHome ?? join(homedir(), ".codex");
  const hooksPath = join(codexHome, "hooks.json");
  const scriptPath =
    input.scriptPath ?? join(codexHome, "agentkit", "pre-tool-use.sh");

  const result: CodexHookTrustStatus = {
    installed: false,
    trusted: false,
    scriptPath,
    hooksPath,
  };

  if (!existsSync(hooksPath) || !existsSync(scriptPath)) return result;

  // The hook is "installed" when hooks.json references our script path.
  let registered = false;
  try {
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
      hooks?: {
        PreToolUse?: Array<{
          hooks?: Array<{ command?: string }>;
        }>;
      };
    };
    registered = (hooks.hooks?.PreToolUse ?? []).some((group) =>
      (group.hooks ?? []).some((hook) => hook.command === scriptPath),
    );
  } catch {
    return result;
  }
  result.installed = registered;
  if (!registered) return result;

  // The hook is "trusted" when config.toml holds the script hash.
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return result;
  const scriptHash = createHash("sha256")
    .update(readFileSync(scriptPath))
    .digest("hex");
  const config = readFileSync(configPath, "utf8");
  const escaped = tomlEscape(hooksPath);
  const section = config.indexOf(`[hooks.state."${escaped}:pre_tool_use:`);
  if (section < 0) return result;
  const sectionBody = config.slice(section, section + 500);
  result.trusted = sectionBody.includes(`sha256:${scriptHash}`);
  return result;
}
