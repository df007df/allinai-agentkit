import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readCodexHookTrustStatus } from "./codex-hooks-trust.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeHome(options: {
  withHooksJson: boolean;
  withScript: boolean;
  trustedHash?: string;
}): string {
  const home = mkdtempSync(path.join(tmpdir(), "codex-trust-"));
  directories.push(home);
  const scriptPath = path.join(home, "agentkit", "pre-tool-use.sh");
  if (options.withScript) {
    mkdirSync(path.dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\necho {}\n");
  }
  if (options.withHooksJson) {
    writeFileSync(
      path.join(home, "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: scriptPath }],
            },
          ],
        },
      }),
    );
  }
  if (options.trustedHash) {
    const scriptHash =
      options.trustedHash === "current"
        ? createHash("sha256").update(readFileSync(scriptPath)).digest("hex")
        : options.trustedHash;
    writeFileSync(
      path.join(home, "config.toml"),
      [
        "[hooks.state]",
        `[hooks.state."${path.join(home, "hooks.json")}:pre_tool_use:0:0"]`,
        `trusted_hash = "sha256:${scriptHash}"`,
        "",
      ].join("\n"),
    );
  }
  return home;
}

describe("codex hook trust probe", () => {
  it("reports not installed when hooks.json does not reference the script", () => {
    const home = writeHome({ withHooksJson: false, withScript: true });
    const status = readCodexHookTrustStatus({ codexHome: home });
    assert.equal(status.installed, false);
    assert.equal(status.trusted, false);
  });

  it("reports installed but untrusted without a config.toml record", () => {
    const home = writeHome({ withHooksJson: true, withScript: true });
    const status = readCodexHookTrustStatus({ codexHome: home });
    assert.equal(status.installed, true);
    assert.equal(status.trusted, false);
  });

  it("reports a stale hash (script edited after trust) as untrusted", () => {
    const home = writeHome({
      withHooksJson: true,
      withScript: true,
      trustedHash: "stale0000000000000000000000000000000000000000000000000000000000",
    });
    const status = readCodexHookTrustStatus({ codexHome: home });
    assert.equal(status.installed, true);
    assert.equal(status.trusted, false);
  });

  it("reports trusted when the config hash matches the current script", () => {
    const home = writeHome({
      withHooksJson: true,
      withScript: true,
      trustedHash: "current",
    });
    const status = readCodexHookTrustStatus({ codexHome: home });
    assert.equal(status.installed, true);
    assert.equal(status.trusted, true);
  });
});
