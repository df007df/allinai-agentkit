import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runCli } from "./commands.js";

describe("agent CLI", () => {
  it("doctor reports missing git without starting a daemon or a run", async () => {
    let daemonStarted = false;
    const output: string[] = [];

    const result = await runCli(["doctor"], {
      homeDir: "/tmp/allinai-cli-test",
      write: (line) => output.push(line),
      which: async () => null,
      probeRuntimes: async () => [],
      createDaemon: async () => {
        daemonStarted = true;
        throw new Error("doctor must not start the daemon");
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(daemonStarted, false);
    assert.match(output.join(""), /git.*missing/i);
  });

  it("delegates a user-level install through an injected service port", async () => {
    const installed: Array<{ platform: NodeJS.Platform; configDir: string }> =
      [];

    const result = await runCli(["install"], {
      homeDir: "/tmp/allinai-cli-test",
      platform: "linux",
      executable: "/opt/bin/allinai-agent",
      write: () => undefined,
      installService: async (input) => {
        installed.push(input);
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(installed.length, 1);
    assert.equal(installed[0]?.platform, "linux");
    assert.equal(
      installed[0]?.configDir,
      "/tmp/allinai-cli-test/.allinai/agent",
    );
  });

  it("uses the local control port for status", async () => {
    const output: string[] = [];
    const result = await runCli(["status"], {
      homeDir: "/tmp/allinai-cli-test",
      write: (line) => output.push(line),
      createControlClient: () => ({
        health: async () => ({ status: "ok" }),
        status: async () => ({ state: "connected", executions: 0 }),
        approve: async () => undefined,
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.match(output.join(""), /connected/);
  });

  it("passes the client-owned JSONL file to an injectable log follower", async () => {
    let followed = "";
    const result = await runCli(["logs", "-f"], {
      homeDir: "/tmp/allinai-cli-test",
      write: () => undefined,
      readLog: async () => '{"message":"already redacted"}\n',
      followLog: async (file) => {
        followed = file;
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(
      followed,
      "/tmp/allinai-cli-test/.allinai/agent/logs/agent.log",
    );
  });

  it("rejects an invalid Hub URL before creating a config file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-init-"));
    try {
      const result = await runCli(
        ["init", "--config-dir", dir, "--hub", "not-a-hub-url"],
        { write: () => undefined },
      );

      assert.equal(result.exitCode, 1);
      assert.equal(existsSync(path.join(dir, "config.json")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown flags and a config-dir flag with no value before service actions", async () => {
    let installs = 0;
    const noValue = await runCli(["install", "--config-dir"], {
      write: () => undefined,
      installService: async () => {
        installs += 1;
      },
    });
    const followedByFlag = await runCli(["install", "--config-dir", "-f"], {
      write: () => undefined,
      installService: async () => {
        installs += 1;
      },
    });
    const unknown = await runCli(["uninstall", "--not-a-real-option"], {
      write: () => undefined,
      uninstallService: async () => {
        installs += 1;
      },
    });

    assert.equal(noValue.exitCode, 1);
    assert.equal(followedByFlag.exitCode, 1);
    assert.equal(unknown.exitCode, 1);
    assert.equal(installs, 0);
  });
});

describe("login command", () => {
  it("stores the token and writes config after browser approval", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "agent-cli-login-"));
    const result = await runCli(
      ["login", "--hub", "http://127.0.0.1:49154", "--client", "fixed-client"],
      {
        configDir,
        credentials: {
          load: async () => null,
          save: async (clientId, token) => {
            assert.equal(clientId, "fixed-client");
            assert.equal(token, "demo-token-cli");
          },
          clear: async () => {},
        },
        openBrowser: async (url) => {
          const authorize = new URL(url);
          const callback = new URL(authorize.searchParams.get("redirect_uri")!);
          callback.searchParams.set("token", "demo-token-cli");
          callback.searchParams.set("state", authorize.searchParams.get("state")!);
          await fetch(callback);
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.some((line) => line.includes('"loggedIn":true')));
  });
});

describe("demo command", () => {
  it("starts the demo site, reports endpoints and waits for shutdown", async () => {
    let closed = false;
    const result = await runCli(
      ["demo", "--port", "0"],
      {
        startDemoSite: async () => ({
          url: "http://127.0.0.1:4317",
          hubUrl: "ws://127.0.0.1:4317/api/agent-hub/v2/ws",
          registry: { list: () => [], register: () => {
            throw new Error("unused");
          }, verify: () => null, revoke: () => false } as never,
          close: async () => {
            closed = true;
          },
        }),
        demoWaiter: async () => {},
      },
    );
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.some((line) => line.includes("4317")));
    assert.ok(result.output.some((line) => line.includes("hubWsUrl")));
    assert.equal(closed, true);
  });
});
