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

  it("saves and loads tokens as mode-0600 files under the Agent home", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "allinai-agentkit-creds-"));
    const store = createCredentialStore({ homeDir: dir });

    await store.save("client-1", "secret-token");
    assert.equal(await store.load("client-1"), "secret-token");

    const file = path.join(
      dir,
      ".allinai",
      "agent",
      "credentials",
      "client-1.token",
    );
    assert.equal(statSync(file).mode & 0o077, 0);

    await store.clear("client-1");
    assert.equal(await store.load("client-1"), null);
  });

  it("replaces an existing token atomically on re-save", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "allinai-agentkit-creds-"));
    const store = createCredentialStore({ homeDir: dir });

    await store.save("client-1", "first-token");
    await store.save("client-1", "second-token");
    assert.equal(await store.load("client-1"), "second-token");
  });

  it("rejects empty tokens and empty clientIds", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "allinai-agentkit-creds-"));
    const store = createCredentialStore({ homeDir: dir });

    await assert.rejects(
      store.save("client-1", "  "),
      /token must be a nonempty string/,
    );
    await assert.rejects(store.load(""), /clientId must be a nonempty string/);
  });

  it("fails closed when a credential file has loose permissions", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "allinai-agentkit-creds-"));
    const file = path.join(dir, "client-1.token");
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(file, "secret-token");
    chmodSync(file, 0o644);
    const store = createCredentialStore({
      paths: { credentialsRoot: dir },
    });

    await assert.rejects(store.load("client-1"), /must have mode 0600/);
  });
});
