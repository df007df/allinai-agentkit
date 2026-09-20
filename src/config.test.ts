import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  defaultAgentConfig,
  loadAgentConfig,
  parseAgentConfig,
  saveAgentConfig,
} from "./config.js";
import { resolveAgentPaths } from "./paths.js";

describe("agent config", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("applies explicit defaults for bounded local settings", () => {
    const config = parseAgentConfig({
      hubBaseUrl: "https://hub.example.test/",
      clientId: "client-1",
    });

    assert.equal(config.hubBaseUrl, "https://hub.example.test");
    assert.equal(config.maxConcurrentRuns, 1);
    assert.deepEqual(config.policy, defaultAgentConfig().policy);
  });

  it("rejects malformed JSON configuration instead of accepting a partial config", () => {
    assert.throws(
      () => parseAgentConfig({ hubBaseUrl: "not a url", clientId: "client-1" }),
      /hubBaseUrl must be an absolute http or https URL/,
    );
    assert.throws(
      () => parseAgentConfig({ hubBaseUrl: "https://hub.example.test" }),
      /clientId must be a nonempty string/,
    );
  });

  it("loads only config.json below agent home", () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-config-"));
    const paths = resolveAgentPaths(dir);
    mkdirSync(paths.home, { recursive: true });
    writeFileSync(
      paths.configFile,
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "client-1",
        maxConcurrentRuns: 2,
      }),
    );

    assert.equal(loadAgentConfig(paths).maxConcurrentRuns, 2);
  });

  it("writes normalized pairing config into the client-owned home", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-config-"));
    const paths = resolveAgentPaths(dir);

    await saveAgentConfig(paths, {
      hubBaseUrl: "https://hub.example.test/",
      clientId: "client-1",
      maxConcurrentRuns: 2,
      projects: [],
      policy: {
        autoRuntimes: ["codex"],
        autoPermissions: [],
        allowedGitOrigins: [],
        deniedPluginIds: [],
        allowedWorkspaceRoots: [],
      },
    });

    assert.deepEqual(loadAgentConfig(paths), {
      hubBaseUrl: "https://hub.example.test",
      clientId: "client-1",
      maxConcurrentRuns: 2,
      policy: {
        autoRuntimes: ["codex"],
        autoPermissions: [],
        allowedGitOrigins: [],
        deniedPluginIds: [],
        allowedWorkspaceRoots: [],
      },
      projects: [],
    });
  });

  it("parses locally registered projects with unique names and absolute paths", () => {
    const config = parseAgentConfig({
      hubBaseUrl: "https://hub.example.test",
      clientId: "client-1",
      projects: [
        { name: "web", path: "/work/web" },
        { name: "api", path: "/work/api/" },
      ],
    });
    assert.deepEqual(config.projects, [
      { name: "web", path: "/work/web" },
      { name: "api", path: "/work/api" },
    ]);

    assert.throws(
      () =>
        parseAgentConfig({
          hubBaseUrl: "https://hub.example.test",
          clientId: "client-1",
          projects: [
            { name: "web", path: "/work/web" },
            { name: "web", path: "/work/other" },
          ],
        }),
      /duplicated/,
    );
    assert.throws(
      () =>
        parseAgentConfig({
          hubBaseUrl: "https://hub.example.test",
          clientId: "client-1",
          projects: [{ name: "relative", path: "work/relative" }],
        }),
      /absolute/,
    );
  });
});
