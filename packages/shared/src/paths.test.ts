import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentHome, resolveAgentPaths } from "./paths.js";

describe("agent paths", () => {
  it("keeps state, plugins, logs and control below one agent home", () => {
    const paths = resolveAgentPaths("/tmp/home");

    assert.equal(resolveAgentHome("/tmp/home"), "/tmp/home/.allinai/agent");
    assert.equal(paths.stateDb, "/tmp/home/.allinai/agent/state.db");
    assert.equal(paths.pluginsRoot, "/tmp/home/.allinai/agent/plugins");
    assert.equal(paths.logsRoot, "/tmp/home/.allinai/agent/logs");
    assert.equal(paths.controlSocket, "/tmp/home/.allinai/agent/control.sock");
  });
});
