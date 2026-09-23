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
      executable: "/opt/bin/allinai-agentkit",
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
    const dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-init-"));
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

describe("web command", () => {
  it("starts the console site, reports endpoints and waits for shutdown", async () => {
    let closed = false;
    const output: string[] = [];
    const result = await runCli(["web", "--port", "0"], {
      write: (line) => output.push(line),
      startConsoleSite: async () => ({
        url: "http://127.0.0.1:4317",
        hubUrl: "ws://127.0.0.1:4317/_agentkit/hub/v2/ws",
        close: async () => {
          closed = true;
        },
      }),
      webWaiter: async () => {},
    });
    assert.equal(result.exitCode, 0);
    assert.ok(output.some((line) => line.includes('"consoleUrl"')));
    assert.ok(output.some((line) => line.includes('"hubWsUrl"')));
    assert.equal(closed, true);
  });

  it("rejects a non-integer or out-of-range --port before starting the site", async () => {
    let started = 0;
    const run = (port: string) =>
      runCli(["web", "--port", port], {
        write: () => undefined,
        startConsoleSite: async () => {
          started += 1;
          throw new Error("site must not start");
        },
        webWaiter: async () => {},
      });
    const fractional = await run("4317.5");
    const tooLarge = await run("65536");
    const notANumber = await run("not-a-port");

    for (const result of [fractional, tooLarge, notANumber]) {
      assert.equal(result.exitCode, 1);
      assert.match(
        result.output.join(""),
        /--port must be an integer between 0 and 65535/,
      );
    }
    assert.equal(started, 0);
  });

  it("explains how to install the web package when its module is missing", async () => {
    // The web package IS a devDependency now, so the default dynamic import
    // would succeed; simulate the absent-package path by injecting a starter
    // that throws the same module-missing error the real default starter
    // surfaces when @allinai/agentkit-web is not installed.
    const result = await runCli(["web"], {
      write: () => undefined,
      startConsoleSite: async () => {
        throw new Error(
          "Console UI not installed. Run: npm i @allin-ai/agentkit-web",
        );
      },
      webWaiter: async () => {},
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.output.join(""), /npm i @allin-ai\/agentkit-web/);
  });
});

describe("project commands", () => {
  it("registers and removes a project in the client-owned config", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "allinai-cli-project-"));
    try {
      const configDir = path.join(dir, "agent-home");
      const config = path.join(configDir, "config.json");
      const output: string[] = [];
      const init = await runCli(
        ["init", "--hub", "https://hub.example.test", "--client", "cli-project"],
        {
          configDir,
          write: () => undefined,
        },
      );
      assert.equal(init.exitCode, 0);

      const added = await runCli(
        ["project", "--name", "web", "--path", "/work/web/"],
        { configDir, write: (line) => output.push(line) },
      );
      assert.equal(added.exitCode, 0);
      const stored = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(config, "utf8")));
      // The record suffix is generated at registration and persists so the
      // session-record root stays stable across restarts.
      assert.equal(stored.projects.length, 1);
      assert.equal(stored.projects[0].name, "web");
      assert.equal(stored.projects[0].path, "/work/web");
      assert.match(stored.projects[0].dir, /^[0-9a-f]{6}$/);

      const list = await runCli(["projects"], {
        configDir,
        write: (line) => output.push(line),
      });
      assert.equal(list.exitCode, 0);
      assert.ok(output.some((line) => line.includes('"web"')));

      const removed = await runCli(
        ["project", "--name", "web", "--remove"],
        { configDir, write: () => undefined },
      );
      assert.equal(removed.exitCode, 0);
      const after = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(config, "utf8")));
      assert.deepEqual(after.projects, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects project registration without an absolute path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "allinai-cli-project-"));
    try {
      const configDir = path.join(dir, "agent-home");
      await runCli(
        ["init", "--hub", "https://hub.example.test", "--client", "cli-project"],
        { configDir, write: () => undefined },
      );
      const result = await runCli(
        ["project", "--name", "bad", "--path", "relative/path"],
        { configDir, write: () => undefined },
      );
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.some((line) => line.includes("absolute")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plugins command", () => {
  it("lists plugins over the control port and refreshes on demand", async () => {
    const output: string[] = [];
    const refreshed: number[] = [];
    const result = await runCli(["plugins", "--refresh"], {
      homeDir: "/tmp/allinai-cli-test",
      write: (line) => output.push(line),
      createControlClient: () => ({
        health: async () => ({ status: "ok" }),
        status: async () => ({ state: "ok" }),
        approve: async () => undefined,
        plugins: async () => [
          { id: "demo-plugin", resolvedCommit: "a".repeat(40), status: "active" },
        ],
        refreshPlugins: async () => {
          refreshed.push(1);
        },
      }),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(refreshed, [1]);
    assert.ok(output.some((line) => line.includes("demo-plugin")));
    assert.ok(output.some((line) => line.includes('"refreshed":true')));
  });
});
