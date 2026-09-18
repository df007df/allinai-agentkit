import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentControlClient } from "../control.js";
import { createLocalAgentDaemon } from "./commands.js";

describe("local agent daemon composition", () => {
  let dir = "";
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("acquires one local control socket and remains unpaired without a credential", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-daemon-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          autoRuntimes: [],
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
    });
    close = () => daemon.close();

    assert.deepEqual(await daemon.health(), { status: "unpaired" });
    assert.equal(
      (await createAgentControlClient(path.join(dir, "control.sock")).status())
        .state,
      "unpaired",
    );
    await assert.rejects(
      createLocalAgentDaemon({ configDir: dir, credentials }),
      /control socket is already active/,
    );
  });
});
