import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  claudeHookScriptSource,
  installClaudeHooks,
} from "./claude-hooks.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("claude hooks installer", () => {
  it("writes the hook script and registers it in settings.json", () => {
    const home = mkdtempSync(path.join(tmpdir(), "claude-hooks-"));
    directories.push(home);

    const result = installClaudeHooks({
      controlEndpoint: "http://127.0.0.1:8787",
      claudeHome: home,
    });

    assert.equal(result.settingsPath, path.join(home, "settings.json"));
    assert.equal(result.merged, false);
    assert.ok(existsSync(result.scriptPath));
    const script = readFileSync(result.scriptPath, "utf8");
    assert.match(script, /control\/tool-approval/);
    assert.match(script, /platform\\":\\"claude/);

    const settings = JSON.parse(readFileSync(result.settingsPath, "utf8")) as {
      hooks: {
        PreToolUse: Array<{
          matcher: string;
          hooks: Array<{ command: string; timeout: number }>;
        }>;
      };
    };
    const group = settings.hooks.PreToolUse[0]!;
    assert.match(group.matcher, /Bash/);
    assert.equal(group.hooks[0]!.command, result.scriptPath);
    assert.match(result.trustNote, /no separate trust step/);
  });

  it("merges into existing settings without duplicating the hook", () => {
    const home = mkdtempSync(path.join(tmpdir(), "claude-hooks-"));
    directories.push(home);
    const first = installClaudeHooks({
      controlEndpoint: "http://127.0.0.1:8787",
      claudeHome: home,
    });

    // Operator had their own hook before ours.
    const settings = JSON.parse(readFileSync(first.settingsPath, "utf8")) as {
      hooks: { PreToolUse: unknown[] };
    };
    settings.hooks.PreToolUse.unshift({
      matcher: "WebFetch",
      hooks: [{ type: "command", command: "/usr/bin/own-hook.sh" }],
    });
    writeFileSync(first.settingsPath, JSON.stringify(settings));

    const second = installClaudeHooks({
      controlEndpoint: "http://127.0.0.1:8787",
      claudeHome: home,
    });

    assert.equal(second.merged, true);
    const after = JSON.parse(readFileSync(first.settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.equal(after.hooks.PreToolUse.length, 2);
    const commands = after.hooks.PreToolUse.flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    assert.equal(
      commands.filter((command) => command === second.scriptPath).length,
      1,
    );
    // The operator's own hook survives.
    assert.ok(commands.includes("/usr/bin/own-hook.sh"));
  });

  it("the generated deny payload uses the hookSpecificOutput shape", () => {
    const script = claudeHookScriptSource("http://127.0.0.1:8787");
    assert.match(script, /permissionDecision":"deny/);
    assert.match(script, /hookEventName":"PreToolUse/);
  });
});
