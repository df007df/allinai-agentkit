import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  installPiApprovalExtension,
  readPiApprovalExtensionEndpoint,
} from "./pi-approval-extension.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("pi approval extension installer", () => {
  it("writes the extension into the auto-discovery directory", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
    directories.push(agentDir);

    const result = installPiApprovalExtension({
      controlEndpoint: "http://127.0.0.1:8787",
      piAgentDir: agentDir,
    });

    assert.equal(
      result.extensionPath,
      path.join(agentDir, "extensions", "agentkit-tool-approval.ts"),
    );
    assert.equal(result.replaced, false);
    const source = readFileSync(result.extensionPath, "utf8");
    assert.match(source, /pi\.on\("tool_call"/);
    assert.match(source, /control\/tool-approval/);
    assert.match(source, /block: true/);
    assert.match(result.note, /auto-discovered/);
  });

  it("replaces an existing installation and the endpoint is probe-readable", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
    directories.push(agentDir);
    installPiApprovalExtension({
      controlEndpoint: "http://127.0.0.1:8787",
      piAgentDir: agentDir,
    });
    const second = installPiApprovalExtension({
      controlEndpoint: "http://127.0.0.1:9999",
      piAgentDir: agentDir,
    });

    assert.equal(second.replaced, true);
    assert.equal(
      readPiApprovalExtensionEndpoint(agentDir),
      "http://127.0.0.1:9999",
    );
  });

  it("endpoint probe returns null when no extension is installed", () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pi-ext-"));
    directories.push(agentDir);
    assert.equal(readPiApprovalExtensionEndpoint(agentDir), null);
  });
});
