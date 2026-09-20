import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCredentialStore } from "./credentials.js";

describe("agent credential store", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("uses the injected macOS security command when Keychain is available", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const store = createCredentialStore({
      homeDir: "/tmp/home",
      platform: "darwin",
      executor: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === "find-generic-password")
          return { code: 0, stdout: "secret-token\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });

    await store.save("client-1", "secret-token");
    assert.equal(await store.load("client-1"), "secret-token");
    await store.clear("client-1");

    assert.deepEqual(
      calls.map((call) => call.file),
      ["security", "security", "security"],
    );
    assert.equal(
      calls.some((call) => call.args.includes("secret-token")),
      true,
    );
  });

  it("falls back atomically to a mode-0600 file only when Keychain is unavailable", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "allinai-agentkit-creds-"));
    let unavailable = true;
    const store = createCredentialStore({
      homeDir: dir,
      platform: "darwin",
      executor: async () => {
        if (!unavailable) {
          return { code: 44, stdout: "", stderr: "could not be found" };
        }
        const error = new Error(
          "security: Keychain is not available",
        ) as Error & { code?: string };
        error.code = "ENOENT";
        throw error;
      },
    });

    await store.save("client-1", "secret-token");
    assert.equal(await store.load("client-1"), "secret-token");
    const fallback = path.join(
      dir,
      ".allinai",
      "agent",
      "credentials",
      "client-1.token",
    );
    assert.equal(statSync(fallback).mode & 0o077, 0);
    unavailable = false;
    assert.equal(await store.load("client-1"), null);
  });

  it("does not fall back when a working Keychain rejects a save", async () => {
    const store = createCredentialStore({
      homeDir: "/tmp/home",
      platform: "darwin",
      executor: async () => ({
        code: 1,
        stdout: "",
        stderr: "security: access denied",
      }),
    });

    await assert.rejects(
      store.save("client-1", "secret-token"),
      /Keychain save failed/,
    );
  });
});
