import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  codexHookScriptSource,
  installCodexHooks,
} from "./codex-hooks.js";

describe("codex hooks installer", () => {
  it("creates hooks.json and an executable-style pre-tool-use script", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-hooks-"));
    const result = installCodexHooks({
      controlEndpoint: "http://127.0.0.1:8787",
      codexHome,
    });

    assert.equal(result.merged, false);
    assert.match(result.trustNote, /\/hooks/);
    const script = readFileSync(result.scriptPath, "utf8");
    assert.match(script, /http:\/\/127\.0\.0\.1:8787\/control\/tool-approval/);
    assert.match(script, /"decision":"block"/);
    const hooks = JSON.parse(readFileSync(result.hooksPath, "utf8"));
    assert.equal(hooks.hooks.PreToolUse[0].hooks[0].command, result.scriptPath);
    // pre_tool_use is Codex's tool-gating hook; no matcher narrows it —
    // the daemon decides what the human needs to weigh in on.
    assert.equal(hooks.hooks.PreToolUse[0].matcher, undefined);
  });

  it("merges into an existing hooks.json without duplicating the hook", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codex-hooks-"));
    installCodexHooks({ controlEndpoint: "http://ep", codexHome });
    const first = JSON.parse(
      readFileSync(join(codexHome, "hooks.json"), "utf8"),
    );
    const second = installCodexHooks({
      controlEndpoint: "http://ep",
      codexHome,
    });

    assert.equal(second.merged, true);
    const merged = JSON.parse(
      readFileSync(join(codexHome, "hooks.json"), "utf8"),
    );
    assert.equal(
      merged.hooks.PreToolUse.length,
      first.hooks.PreToolUse.length,
    );
    assert.ok(existsSync(second.scriptPath));
  });
});
