import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  claudeHookScriptSource,
  claudeHooksSettingsFragment,
  installClaudeHooks,
} from "./claude-hooks.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("claude hooks installer", () => {
  it("writes the hook script and registers it under PermissionRequest", () => {
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
        PermissionRequest: Array<{
          hooks: Array<{ command: string; timeout: number }>;
        }>;
      };
    };
    const group = settings.hooks.PermissionRequest[0]!;
    // PermissionRequest fires only at the platform's ask-user moment —
    // exactly what we relay. There is no matcher: the event itself scopes it.
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
      hooks: { PermissionRequest: unknown[] };
    };
    settings.hooks.PermissionRequest.unshift({
      hooks: [{ type: "command", command: "/usr/bin/own-hook.sh" }],
    });
    writeFileSync(first.settingsPath, JSON.stringify(settings));

    const second = installClaudeHooks({
      controlEndpoint: "http://127.0.0.1:8787",
      claudeHome: home,
    });

    assert.equal(second.merged, true);
    const after = JSON.parse(readFileSync(first.settingsPath, "utf8")) as {
      hooks: {
        PermissionRequest: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    assert.equal(after.hooks.PermissionRequest.length, 2);
    const commands = after.hooks.PermissionRequest.flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    assert.equal(
      commands.filter((command) => command === second.scriptPath).length,
      1,
    );
    // The operator's own hook survives.
    assert.ok(commands.includes("/usr/bin/own-hook.sh"));
  });

  it("the generated deny payload uses the PermissionRequest decision shape", () => {
    const script = claudeHookScriptSource("http://127.0.0.1:8787");
    assert.match(script, /hookEventName":"PermissionRequest/);
    assert.match(script, /"behavior":"deny"/);
  });

  it("the settings fragment targets the PermissionRequest event only", () => {
    const fragment = claudeHooksSettingsFragment("/path/hook.sh");
    const hooks = fragment.hooks as Record<string, unknown>;
    assert.deepEqual(Object.keys(hooks), ["PermissionRequest"]);
  });
});
