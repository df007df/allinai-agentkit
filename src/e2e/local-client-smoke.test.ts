import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentControlClient } from "../control.js";
import { createAgentHub } from "../hub/index.js";
import { MemoryHubStore } from "../hub/testkit/index.js";
import { resetBridgeLogger } from "../logger.js";
import { PluginManager } from "../plugins/manager.js";
import type {
  RunnerManager,
  PlatformEvent,
  PlatformRunInput,
} from "../runtime/types.js";
import { ClientStateStore } from "../client/state-store.js";
import {
  WsClientTransport,
  type ClientWebSocketLike,
} from "../client/ws-transport.js";
import {
  createLocalAgentDaemon,
  type LocalAgentDaemon,
} from "../cli/commands.js";

const HUB_TOKEN = "local-client-smoke-token";
const CLIENT_ID = "local-client-smoke";
const REMOTE_PLUGIN_URL = "https://fixture.test/local-client-smoke-plugin.git";
const HUB_PATH_PREFIX = "/local-client-smoke-hub";

type Fixture = {
  root: string;
  home: string;
  workspace: string;
  repo: string;
  commit: string;
  gitConfig: string;
};

type DaemonStatus = {
  state: string;
  executions: Array<{
    executionId: string;
    state: string;
  }>;
  plugins: Array<{ id: string; resolvedCommit: string; status: string }>;
};

class BlockingRunner implements RunnerManager {
  readonly started: Array<{ executionId: string; input: PlatformRunInput }> =
    [];
  readonly cancelled: string[] = [];
  private readonly releases = new Map<string, () => void>();
  private readonly idleWaiters = new Set<() => void>();

  start(
    executionId: string,
    input: PlatformRunInput,
  ): AsyncIterable<PlatformEvent> {
    this.started.push({ executionId, input });
    let release: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.releases.set(executionId, release!);
    const self = this;
    return (async function* () {
      await stopped;
      self.releases.delete(executionId);
      if (self.releases.size === 0) {
        for (const resolveIdle of self.idleWaiters) resolveIdle();
        self.idleWaiters.clear();
      }
    })();
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelled.push(executionId);
    this.releases.get(executionId)?.();
  }

  async waitForIdle(): Promise<void> {
    if (this.releases.size === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  get activeCount(): number {
    return this.releases.size;
  }
}

class ObservedWebSocket implements ClientWebSocketLike {
  static instances: ObservedWebSocket[] = [];

  private readonly socket: WebSocket;
  private messageHandler: ((event: { data: unknown }) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: (() => void) | null = null;
  private openHandler: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    ObservedWebSocket.instances.push(this);
    this.socket.onmessage = (event) =>
      this.messageHandler?.({ data: event.data });
    this.socket.onclose = () => this.closeHandler?.();
    this.socket.onerror = () => this.errorHandler?.();
    this.socket.onopen = () => this.openHandler?.();
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get onmessage(): ((event: { data: unknown }) => void) | null {
    return this.messageHandler;
  }

  set onmessage(value: ((event: { data: unknown }) => void) | null) {
    this.messageHandler = value;
  }

  get onclose(): (() => void) | null {
    return this.closeHandler;
  }

  set onclose(value: (() => void) | null) {
    this.closeHandler = value;
  }

  get onerror(): (() => void) | null {
    return this.errorHandler;
  }

  set onerror(value: (() => void) | null) {
    this.errorHandler = value;
  }

  get onopen(): (() => void) | null {
    return this.openHandler;
  }

  set onopen(value: (() => void) | null) {
    this.openHandler = value;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  disconnectForReconnect(): void {
    this.socket.close();
  }
}

const temporaryDirectories: string[] = [];
let daemon: LocalAgentDaemon | null = null;
let closeHub: (() => Promise<void>) | null = null;
let previousGitConfig: string | undefined;
let previousNoSystemConfig: string | undefined;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  await closeHub?.();
  closeHub = null;
  resetBridgeLogger();
  ObservedWebSocket.instances.splice(0);
  if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
  if (previousNoSystemConfig === undefined)
    delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystemConfig;
  previousGitConfig = undefined;
  previousNoSystemConfig = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "allinai-local-client-smoke-"));
  temporaryDirectories.push(root);
  const home = path.join(root, "agent-home");
  const workspace = path.join(root, "workspace");
  const repo = path.join(root, "fixture-plugin");
  const gitConfig = path.join(root, "gitconfig");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });

  const entry = path.join(repo, "bin", "write-result.mjs");
  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    `#!${process.execPath}\nimport { writeFile } from "node:fs/promises";\nimport path from "node:path";\nlet requestText = "";\nfor await (const chunk of process.stdin) requestText += chunk;\nconst request = JSON.parse(requestText);\nawait writeFile(path.join(request.context.workspace.path, "capability-ran.json"), JSON.stringify({ input: request.input, context: request.context }));\nprocess.stdout.write(JSON.stringify({ type: "result", payload: { wrote: true } }) + "\\n");\n`,
  );
  chmodSync(entry, 0o700);
  writeFileSync(
    path.join(repo, "allinai-plugin.json"),
    JSON.stringify({
      id: "smoke-plugin",
      runtimes: ["codex"],
      capabilities: [
        {
          id: "smoke.write",
          entry: "bin/write-result.mjs",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
            additionalProperties: false,
          },
          contextKeys: ["execution", "workspace"],
          permissions: ["workspace:write"],
          timeoutSeconds: 10,
        },
      ],
    }),
  );
  git(repo, ["init", "--initial-branch=main"]);
  git(repo, ["config", "user.email", "local-client-smoke@example.test"]);
  git(repo, ["config", "user.name", "Local Client Smoke"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "fixture capability"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(
    gitConfig,
    `[url "file://${repo}"]\n\tinsteadOf = ${REMOTE_PLUGIN_URL}\n`,
  );
  return { root, home, workspace, repo, commit, gitConfig };
}

function configureGitFixture(fixture: Fixture): void {
  previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  previousNoSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = fixture.gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

async function bootstrapPlugin(fixture: Fixture): Promise<void> {
  const state = new ClientStateStore(path.join(fixture.home, "state.db"));
  try {
    const plugins = new PluginManager({
      pluginsRoot: path.join(fixture.home, "plugins"),
      allowedGitOrigins: ["fixture.test"],
      stateStore: state,
    });
    const [installed] = await plugins.sync([
      {
        id: "smoke-plugin",
        gitUrl: REMOTE_PLUGIN_URL,
        ref: fixture.commit,
        enabled: true,
        runtimes: ["codex"],
      },
    ]);
    assert.equal(installed?.status, "active");
    assert.equal(installed?.resolvedCommit, fixture.commit);
  } finally {
    state.close();
  }
}

function agentCommand(commandId: string) {
  return {
    kind: "agent.run" as const,
    commandId,
    executionId: "agent-execution",
    taskId: "agent-task",
    attempt: 1,
    runtime: "codex" as const,
    payload: { prompt: "perform the local smoke task" },
  };
}

function capabilityCommand() {
  return {
    kind: "capability.invoke" as const,
    commandId: "capability-command",
    executionId: "capability-execution",
    taskId: "capability-task",
    attempt: 1,
    capabilityId: "smoke.write",
    input: { message: "only after approval" },
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function statusFor(controlSocket: string) {
  return createAgentControlClient(
    controlSocket,
  ).status() as Promise<DaemonStatus>;
}

describe("local Agent Client smoke", () => {
  it("deduplicates Hub commands, replays its durable outbox, audits the fixed plugin commit, and closes cleanly", async () => {
    const fixture = makeFixture();
    configureGitFixture(fixture);
    await bootstrapPlugin(fixture);
    const hubStore = new MemoryHubStore<string>();
    const hub = createAgentHub({
      authorize: async (candidate) =>
        candidate === HUB_TOKEN ? candidate : null,
      store: hubStore,
      pathPrefix: HUB_PATH_PREFIX,
    });
    const server = http.createServer();
    hub.attach(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    closeHub = async () => {
      await hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    };
    const hubBaseUrl = `http://127.0.0.1:${address.port}`;
    writeFileSync(
      path.join(fixture.home, "config.json"),
      JSON.stringify({
        hubBaseUrl,
        clientId: CLIENT_ID,
        maxConcurrentRuns: 2,
        policy: {
          autoRuntimes: ["codex"],
          autoPermissions: [],
          allowedGitOrigins: ["fixture.test"],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [fixture.workspace],
        },
      }),
    );

    const runner = new BlockingRunner();
    daemon = await createLocalAgentDaemon({
      configDir: fixture.home,
      credentials: {
        load: async () => HUB_TOKEN,
        save: async () => undefined,
        clear: async () => undefined,
      },
      createRunner: () => runner,
      createTransport: (input) =>
        new WsClientTransport({
          ...input,
          pathPrefix: HUB_PATH_PREFIX,
          WebSocketImpl: ObservedWebSocket,
          reconnectBaseMs: 1,
          reconnectMaxMs: 10,
        }),
    });
    const controlSocket = path.join(fixture.home, "control.sock");
    const capabilityOutput = path.join(
      fixture.workspace,
      "capability-ran.json",
    );

    await waitUntil(
      async () => (await statusFor(controlSocket)).state === "ok",
      "the Agent Client WebSocket connection",
    );

    await hub.offer({
      principal: HUB_TOKEN,
      targetClientId: CLIENT_ID,
      command: agentCommand("agent-command-one"),
    });
    await hub.offer({
      principal: HUB_TOKEN,
      targetClientId: CLIENT_ID,
      command: agentCommand("agent-command-retry"),
    });
    await waitUntil(
      async () =>
        (await statusFor(controlSocket)).executions.some(
          (execution) =>
            execution.executionId === "agent-execution" &&
            execution.state === "running",
        ),
      "one admitted agent command",
    );
    assert.equal(runner.started.length, 1);
    assert.equal(runner.started[0]?.executionId, "agent-execution");
    await createAgentControlClient(controlSocket).sync?.();
    await waitUntil(
      () => hubStore.listEvents("agent-execution").length === 2,
      "agent event acknowledgement",
    );
    assert.deepEqual(
      hubStore.listEvents("agent-execution").map((event) => event.type),
      ["received", "running"],
    );
    assert.deepEqual(hubStore.listEvents("agent-execution")[0]?.payload, {
      pluginSnapshot: [{ id: "smoke-plugin", resolvedCommit: fixture.commit }],
    });
    assert.deepEqual(hubStore.listEvents("agent-execution")[1]?.payload, {
      runtime: "codex",
      pluginSnapshot: [{ id: "smoke-plugin", resolvedCommit: fixture.commit }],
    });

    await hub.offer({
      principal: HUB_TOKEN,
      targetClientId: CLIENT_ID,
      command: capabilityCommand(),
    });
    await waitUntil(
      async () =>
        (await statusFor(controlSocket)).executions.some(
          (execution) =>
            execution.executionId === "capability-execution" &&
            execution.state === "awaiting_approval",
        ),
      "local capability approval",
    );
    assert.equal(existsSync(capabilityOutput), false);

    const socketCountBeforeReconnect = ObservedWebSocket.instances.length;
    ObservedWebSocket.instances.at(-1)?.disconnectForReconnect();
    await waitUntil(
      () => ObservedWebSocket.instances.length > socketCountBeforeReconnect,
      "WebSocket reconnect",
    );
    await waitUntil(
      () => hubStore.listEvents("capability-execution").length === 2,
      "replayed durable capability events",
    );
    assert.deepEqual(
      hubStore
        .listEvents("capability-execution")
        .map((event) => [event.eventSeq, event.type]),
      [
        [1, "received"],
        [2, "awaiting_approval"],
      ],
    );
    assert.equal(
      hubStore
        .snapshot()
        .offers.some(
          (offer) => offer.command.executionId === "capability-execution",
        ),
      false,
    );

    await createAgentControlClient(controlSocket).approve(
      "capability-execution",
    );
    await waitUntil(
      () => existsSync(capabilityOutput),
      "approved fixed capability entrypoint execution",
    );
    await waitUntil(
      async () =>
        (await statusFor(controlSocket)).executions.some(
          (execution) =>
            execution.executionId === "capability-execution" &&
            execution.state === "done",
        ),
      "capability completion",
    );
    await createAgentControlClient(controlSocket).sync?.();
    await waitUntil(
      () => hubStore.listEvents("capability-execution").length === 4,
      "capability terminal acknowledgement",
    );

    const plugin = (await statusFor(controlSocket)).plugins[0];
    assert.equal(plugin?.id, "smoke-plugin");
    assert.equal(plugin?.resolvedCommit, fixture.commit);
    assert.equal(plugin?.status, "active");
    const fixtureOutput = readFileSync(capabilityOutput, "utf8");
    const localLog = readFileSync(
      path.join(fixture.home, "logs", "agent.log"),
      "utf8",
    );
    assert.doesNotMatch(fixtureOutput, new RegExp(HUB_TOKEN));
    assert.doesNotMatch(localLog, new RegExp(HUB_TOKEN));

    await daemon.close();
    daemon = null;
    await waitUntil(
      () =>
        runner.activeCount === 0 &&
        runner.cancelled.includes("agent-execution") &&
        !existsSync(controlSocket) &&
        ObservedWebSocket.instances.every((socket) => socket.readyState === 3),
      "daemon child, socket, and control cleanup",
    );
  });
});
