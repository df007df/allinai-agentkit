import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createCredentialStore, type CredentialStore } from "./credentials.js";
import { resolveAgentPathsAt } from "./paths.js";
import { runLoginFlow } from "./login.js";

function tempCredentialStore(): CredentialStore {
  const home = mkdtempSync(path.join(tmpdir(), "agent-login-test-"));
  return createCredentialStore({ paths: resolveAgentPathsAt(home) });
}

describe("login flow", () => {
  it("completes when the loopback callback receives token and state", async () => {
    const credentials = tempCredentialStore();
    const savedConfig: unknown[] = [];
    const result = await runLoginFlow({
      hubBaseUrl: "http://127.0.0.1:49153",
      clientId: "login-flow-client",
      credentials,
      saveConfig: async (input) => {
        savedConfig.push(input);
      },
      open: async (url) => {
        const authorize = new URL(url);
        assert.equal(authorize.pathname, "/login");
        assert.equal(authorize.searchParams.get("client_id"), "login-flow-client");
        const state = authorize.searchParams.get("state") ?? "";
        const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
        const callback = new URL(redirectUri);
        callback.searchParams.set("token", "demo-token-1");
        callback.searchParams.set("state", state);
        await fetch(callback);
      },
      timeoutMs: 5_000,
    });
    assert.equal(result.token, "demo-token-1");
    assert.equal(await credentials.load("login-flow-client"), "demo-token-1");
    assert.deepEqual(savedConfig, [
      { hubBaseUrl: "http://127.0.0.1:49153", clientId: "login-flow-client" },
    ]);
  });

  it("rejects state mismatch and denied authorizations", async () => {
    const credentials = tempCredentialStore();
    await assert.rejects(
      runLoginFlow({
        hubBaseUrl: "http://127.0.0.1:49153",
        clientId: "client-a",
        credentials,
        saveConfig: async () => {},
        open: async (url) => {
          const authorize = new URL(url);
          const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
          const callback = new URL(redirectUri);
          callback.searchParams.set("token", "demo-token-2");
          callback.searchParams.set("state", "wrong-state");
          await fetch(callback);
        },
        timeoutMs: 5_000,
      }),
      /state/i,
    );

    await assert.rejects(
      runLoginFlow({
        hubBaseUrl: "http://127.0.0.1:49153",
        clientId: "client-b",
        credentials,
        saveConfig: async () => {},
        open: async (url) => {
          const authorize = new URL(url);
          const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
          const callback = new URL(redirectUri);
          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("state", authorize.searchParams.get("state") ?? "");
          await fetch(callback);
        },
        timeoutMs: 5_000,
      }),
      /access_denied/,
    );
  });
});
