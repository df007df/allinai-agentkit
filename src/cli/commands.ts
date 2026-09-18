import { mkdir, readFile, watch, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createAgentControlClient,
  startAgentControlServer,
  type AgentControlClient,
} from "../control.js";
import { createCredentialStore, type CredentialStore } from "../credentials.js";
import {
  defaultAgentConfig,
  loadAgentConfig,
  parseAgentConfig,
  type AgentConfig,
} from "../config.js";
import { defaultOpenBrowser, runLoginFlow } from "../login.js";
import { startDemoSite, type DemoSite } from "../demo/index.js";
import {
  createRotatingJsonlLogger,
  setBridgeLogger,
  serializeLog,
} from "../logger.js";
import { resolveAgentPaths, type AgentPaths } from "../paths.js";
import { PluginManager } from "../plugins/manager.js";
import { parsePluginManifest } from "../plugins/manifest.js";
import { ShellCapabilityHost } from "../capabilities/shell-host.js";
import type { ShellCapability } from "../capabilities/types.js";
import { ClientStateStore } from "../client/state-store.js";
import { ClientSupervisor } from "../client/supervisor.js";
import type { ClientTransport } from "../client/transport.js";
import { WsClientTransport } from "../client/ws-transport.js";
import {
  createPlatformAdapterRegistry,
  createRunnerManager,
  type PlatformProbe,
  type RunnerManager,
} from "../runtime/index.js";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  type UserServiceExecutor,
} from "../service/launchd.js";
import {
  installSystemdUserService,
  restartSystemdUserService,
  uninstallSystemdUserService,
} from "../service/systemd.js";

type Writable = (line: string) => void;

export type RuntimeProbeResult = {
  id: string;
  probe: PlatformProbe;
};

export type LocalAgentDaemon = {
  health(): Promise<{ status: "ok" | "degraded" | "unpaired" }>;
  status(): Promise<Record<string, unknown>>;
  sync(): Promise<void>;
  close(): Promise<void>;
  /** Resolves after an OS shutdown signal. Kept injectable so CLI tests never hang. */
  wait(): Promise<void>;
};

export type UserServiceInput = {
  platform: NodeJS.Platform;
  homeDir: string;
  configDir: string;
  executable: string;
};

export type CliResult = { exitCode: 0 | 1; output: string[] };

export type RunCliOptions = {
  homeDir?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  executable?: string;
  uid?: number;
  write?: Writable;
  which?: (name: string) => Promise<string | null>;
  probeRuntimes?: () => Promise<RuntimeProbeResult[]>;
  createDaemon?: (
    options: LocalAgentDaemonOptions,
  ) => Promise<LocalAgentDaemon>;
  createControlClient?: (endpoint: string) => AgentControlClient;
  installService?: (input: UserServiceInput) => Promise<void>;
  uninstallService?: (input: UserServiceInput) => Promise<void>;
  restartService?: (input: UserServiceInput) => Promise<void>;
  readLog?: (file: string) => Promise<string>;
  followLog?: (
    file: string,
    write: Writable,
    signal?: AbortSignal,
  ) => Promise<void>;
  signal?: AbortSignal;
  credentials?: CredentialStore;
  openBrowser?: (url: string) => Promise<void>;
  startDemoSite?: (options: { port?: number; host?: string }) => Promise<DemoSite>;
  demoWaiter?: () => Promise<void>;
};

export type LocalAgentDaemonOptions = {
  homeDir?: string;
  configDir?: string;
  platform?: NodeJS.Platform;
  credentials?: CredentialStore;
  createControlServer?: typeof startAgentControlServer;
  createStore?: (stateDb: string) => ClientStateStore;
  createTransport?: (input: {
    hubBaseUrl: string;
    token: string;
    clientId: string;
  }) => ClientTransport;
  createRunner?: () => RunnerManager;
  loadConfig?: (paths: Pick<AgentPaths, "configFile">) => AgentConfig;
  mkdir?: (
    dir: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;
  readPluginManifest?: (file: string) => Promise<string>;
};

type ParsedArgs = { command: string | null; flags: Map<string, string | true> };

type CommandOptionSpec = {
  values?: readonly string[];
  booleans?: readonly string[];
};

/**
 * Keep each command's accepted surface deliberately small. In particular,
 * service commands must never reinterpret a malformed --config-dir as the
 * default Agent home: that could install or remove a user service for the
 * wrong client instance.
 */
const COMMAND_OPTIONS: Readonly<Record<string, CommandOptionSpec>> = {
  init: { values: ["hub", "client", "token", "config-dir"] },
  login: { values: ["hub", "client", "config-dir"], booleans: ["no-browser"] },
  demo: { values: ["port", "host", "config-dir"] },
  daemon: { values: ["config-dir"] },
  install: { values: ["config-dir"] },
  status: { values: ["config-dir"] },
  logs: { values: ["config-dir"], booleans: ["f"] },
  sync: { values: ["config-dir"] },
  restart: { values: ["config-dir"] },
  uninstall: { values: ["config-dir"] },
  doctor: { values: ["config-dir"] },
};

function parseArgs(args: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  let command: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-f") {
      flags.set("f", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      if (command) throw new Error(`Unexpected argument: ${arg}`);
      command = arg;
      continue;
    }
    const name = arg.slice(2);
    if (!name) throw new Error("Invalid empty option");
    const next = args[index + 1];
    if (next && !next.startsWith("-")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function validateCommandOptions(
  command: string,
  flags: ReadonlyMap<string, string | true>,
): void {
  const specification = COMMAND_OPTIONS[command];
  if (!specification) throw new Error(`Unknown command: ${command}`);

  for (const [name, value] of flags) {
    if (name === "help") {
      if (value !== true) throw new Error("--help does not accept a value");
      continue;
    }
    if (specification.values?.includes(name)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`--${name} requires a value`);
      }
      continue;
    }
    if (specification.booleans?.includes(name)) {
      if (value !== true) throw new Error(`--${name} does not accept a value`);
      continue;
    }
    throw new Error(`--${name} is not supported for ${command}`);
  }
}

function flagValue(
  flags: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function agentPaths(
  options: Pick<RunCliOptions, "homeDir" | "configDir">,
): AgentPaths {
  if (!options.configDir) return resolveAgentPaths(options.homeDir);
  const home = path.resolve(options.configDir);
  if (!path.isAbsolute(home) || home.length < 2) {
    throw new TypeError("configDir must be an absolute Agent home path");
  }
  return {
    home,
    configFile: path.join(home, "config.json"),
    stateDb: path.join(home, "state.db"),
    credentialsRoot: path.join(home, "credentials"),
    pluginsRoot: path.join(home, "plugins"),
    runsRoot: path.join(home, "runs"),
    logsRoot: path.join(home, "logs"),
    controlSocket: path.join(home, "control.sock"),
  };
}

function executable(options: RunCliOptions): string {
  return options.executable ?? process.argv[1] ?? "allinai-agent";
}

function serviceInput(options: RunCliOptions): UserServiceInput {
  const paths = agentPaths(options);
  return {
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os.homedir(),
    configDir: paths.home,
    executable: executable(options),
  };
}

function serviceExecutor(): UserServiceExecutor {
  return async (file, args) => {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile(file, [...args], { shell: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };
}

async function installDefaultService(
  input: UserServiceInput,
  options: RunCliOptions,
): Promise<void> {
  const execute = serviceExecutor();
  if (input.platform === "darwin") {
    await installLaunchAgent({
      ...input,
      uid: options.uid ?? process.getuid?.() ?? -1,
      execute,
    });
    return;
  }
  if (input.platform === "linux") {
    await installSystemdUserService({
      ...input,
      uid: options.uid ?? process.getuid?.() ?? -1,
      execute,
    });
    return;
  }
  throw new Error(`User service is not supported on ${input.platform}`);
}

async function uninstallDefaultService(
  input: UserServiceInput,
  options: RunCliOptions,
): Promise<void> {
  const execute = serviceExecutor();
  if (input.platform === "darwin") {
    await uninstallLaunchAgent({
      homeDir: input.homeDir,
      uid: options.uid ?? process.getuid?.() ?? -1,
      execute,
    });
    return;
  }
  if (input.platform === "linux") {
    await uninstallSystemdUserService({
      homeDir: input.homeDir,
      uid: options.uid ?? process.getuid?.() ?? -1,
      execute,
    });
    return;
  }
  throw new Error(`User service is not supported on ${input.platform}`);
}

async function restartDefaultService(input: UserServiceInput): Promise<void> {
  const execute = serviceExecutor();
  if (input.platform === "darwin") {
    const { AGENT_SERVICE_LABEL } = await import("../service/launchd.js");
    const uid = process.getuid?.() ?? -1;
    if (uid <= 0)
      throw new Error("Agent service restart requires a non-root user");
    await execute("launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${AGENT_SERVICE_LABEL}`,
    ]);
    return;
  }
  if (input.platform === "linux") {
    await restartSystemdUserService(execute);
    return;
  }
  throw new Error(`User service is not supported on ${input.platform}`);
}

function emit(output: string[], write: Writable, value: unknown): void {
  const line = typeof value === "string" ? value : JSON.stringify(value);
  output.push(line);
  write(`${line}\n`);
}

function redactLogDocument(document: string): string {
  return document
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return serializeLog(parsed).trimEnd();
      } catch {
        return JSON.stringify({ message: "[unparseable log line]" });
      }
    })
    .join("\n");
}

async function defaultWhich(name: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string | null>((resolve) => {
    execFile("which", [name], { shell: false }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(String(stdout).trim() || null);
    });
  });
}

async function defaultProbeRuntimes(): Promise<RuntimeProbeResult[]> {
  const registry = createPlatformAdapterRegistry();
  return await Promise.all(
    registry.list().map(async (adapter) => ({
      id: adapter.id,
      probe: await adapter.probe(),
    })),
  );
}

/** Follow only the client-owned JSONL file and reapply redaction before output. */
async function defaultFollowLog(
  file: string,
  write: Writable,
  signal?: AbortSignal,
): Promise<void> {
  let current = await readFile(file, "utf8");
  for await (const event of watch(file, { signal })) {
    if (event.eventType !== "change" && event.eventType !== "rename") continue;
    let next: string;
    try {
      next = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const appended = next.startsWith(current)
      ? next.slice(current.length)
      : next;
    current = next;
    const safe = redactLogDocument(appended);
    if (safe) write(`${safe}\n`);
  }
}

function help(): string {
  return "Usage: allinai-agent <init|login|daemon|demo|install|status|logs|sync|restart|uninstall|doctor> [--config-dir PATH]";
}

/**
 * Testable command dispatcher. All system and local-daemon effects cross an
 * explicit option port, so tests never register an actual user service.
 */
export async function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const output: string[] = [];
  const write = options.write ?? ((line: string) => process.stdout.write(line));
  try {
    const parsed = parseArgs(args);
    if (!parsed.command) {
      if (
        parsed.flags.size === 0 ||
        (parsed.flags.size === 1 && parsed.flags.get("help") === true)
      ) {
        emit(output, write, help());
        return { exitCode: 0, output };
      }
      throw new Error("A command is required");
    }
    validateCommandOptions(parsed.command, parsed.flags);
    if (parsed.flags.has("help")) {
      emit(output, write, help());
      return { exitCode: 0, output };
    }

    const configDir = flagValue(parsed.flags, "config-dir");
    const scopedOptions = configDir ? { ...options, configDir } : options;
    const paths = agentPaths(scopedOptions);
    const command = parsed.command;

    if (command === "login") {
      const hubBaseUrl = flagValue(parsed.flags, "hub");
      if (!hubBaseUrl)
        throw new Error("login requires --hub http://127.0.0.1:4317");
      const noBrowser = parsed.flags.get("no-browser") === true;
      const existing = await readConfigIfExists(paths.configFile);
      const clientId =
        flagValue(parsed.flags, "client") ??
        existing?.clientId ??
        randomUUID();
      await mkdir(paths.home, { recursive: true });
      const result = await runLoginFlow({
        hubBaseUrl,
        clientId,
        credentials:
          scopedOptions.credentials ?? createCredentialStore({ paths }),
        saveConfig: async (input) => {
          const config = parseAgentConfig({
            ...(existing ?? defaultAgentConfig()),
            hubBaseUrl: input.hubBaseUrl,
            clientId: input.clientId,
          });
          await writeFile(
            paths.configFile,
            `${JSON.stringify(config, null, 2)}\n`,
            { encoding: "utf8", mode: 0o600 },
          );
        },
        open: noBrowser
          ? async () => {}
          : scopedOptions.openBrowser ?? defaultOpenBrowser,
        onAuthorizeUrl: (url) => emit(output, write, { authorizeUrl: url }),
        timeoutMs: 120_000,
      });
      emit(output, write, {
        loggedIn: true,
        clientId: result.clientId,
        hubBaseUrl: result.hubBaseUrl,
      });
      return { exitCode: 0, output };
    }

    if (command === "demo") {
      const portFlag = flagValue(parsed.flags, "port");
      const port = portFlag === undefined ? undefined : Number(portFlag);
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port < 0 || port > 65535)
      ) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      const host = flagValue(parsed.flags, "host");
      const site = await (scopedOptions.startDemoSite ?? startDemoSite)({
        port,
        host,
      });
      emit(output, write, {
        demoUrl: site.url,
        hubWsUrl: site.hubUrl,
      });
      const wait = scopedOptions.demoWaiter ?? waitForShutdownSignal;
      await wait();
      await site.close();
      return { exitCode: 0, output };
    }

    if (command === "init") {
      const hubBaseUrl = flagValue(parsed.flags, "hub");
      const clientId = flagValue(parsed.flags, "client") ?? randomUUID();
      const token = flagValue(parsed.flags, "token");
      if (!hubBaseUrl)
        throw new Error("init requires --hub https://hub.example");
      const config = parseAgentConfig({
        hubBaseUrl,
        clientId,
        maxConcurrentRuns: 1,
        policy: {
          autoRuntimes: [],
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      });
      await mkdir(paths.home, { recursive: true });
      await writeFile(
        paths.configFile,
        `${JSON.stringify(config, null, 2)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      if (token) {
        await (
          scopedOptions.credentials ?? createCredentialStore({ paths })
        ).save(clientId, token);
      }
      emit(output, write, {
        initialized: true,
        configDir: paths.home,
        clientId,
        paired: Boolean(token),
      });
      return { exitCode: 0, output };
    }

    if (command === "daemon") {
      const daemon = await (
        scopedOptions.createDaemon ?? createLocalAgentDaemon
      )({
        ...scopedOptions,
      });
      emit(output, write, await daemon.health());
      try {
        await daemon.wait();
      } finally {
        await daemon.close();
      }
      return { exitCode: 0, output };
    }

    if (command === "install") {
      const input = serviceInput(scopedOptions);
      await (
        scopedOptions.installService ??
        ((service) => installDefaultService(service, scopedOptions))
      )(input);
      emit(output, write, {
        installed: true,
        platform: input.platform,
        configDir: input.configDir,
      });
      return { exitCode: 0, output };
    }

    if (command === "uninstall") {
      const input = serviceInput(scopedOptions);
      await (
        scopedOptions.uninstallService ??
        ((service) => uninstallDefaultService(service, scopedOptions))
      )(input);
      emit(output, write, { uninstalled: true, platform: input.platform });
      return { exitCode: 0, output };
    }

    if (command === "restart") {
      const input = serviceInput(scopedOptions);
      await (scopedOptions.restartService ?? restartDefaultService)(input);
      emit(output, write, { restarted: true, platform: input.platform });
      return { exitCode: 0, output };
    }

    const control = (
      scopedOptions.createControlClient ?? createAgentControlClient
    )(paths.controlSocket);
    if (command === "status") {
      emit(output, write, {
        health: await control.health(),
        status: await control.status(),
      });
      return { exitCode: 0, output };
    }
    if (command === "sync") {
      if (!control.sync)
        throw new Error("Local Agent Client does not support sync yet");
      await control.sync();
      emit(output, write, { synced: true });
      return { exitCode: 0, output };
    }
    if (command === "logs") {
      const follow = parsed.flags.has("f");
      const logFile = path.join(paths.logsRoot, "agent.log");
      const read =
        scopedOptions.readLog ?? ((file: string) => readFile(file, "utf8"));
      const content = await read(logFile);
      const safe = redactLogDocument(content);
      if (safe) emit(output, write, safe);
      if (follow) {
        await (scopedOptions.followLog ?? defaultFollowLog)(
          logFile,
          write,
          scopedOptions.signal,
        );
      }
      return { exitCode: 0, output };
    }
    if (command === "doctor") {
      const which = scopedOptions.which ?? defaultWhich;
      const git = await which("git");
      let config: AgentConfig | null = null;
      let configError: string | null = null;
      try {
        config = loadAgentConfig(paths);
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
      const probes = await (
        scopedOptions.probeRuntimes ?? defaultProbeRuntimes
      )();
      let paired = false;
      if (config) {
        paired = Boolean(
          await (
            scopedOptions.credentials ?? createCredentialStore({ paths })
          ).load(config.clientId),
        );
      }
      const report = {
        git: git ? "ok" : "missing",
        config: config ? "ok" : "invalid",
        paired,
        runtimes: probes.map(({ id, probe }) => ({ id, ...probe })),
        ...(configError ? { configError } : {}),
      };
      emit(output, write, report);
      return { exitCode: git && config ? 0 : 1, output };
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    emit(output, write, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { exitCode: 1, output };
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function capabilityHost(
  store: ClientStateStore,
  paths: AgentPaths,
  readManifest: (file: string) => Promise<string>,
) {
  return {
    async resolveActiveCapability(capabilityId: string) {
      for (const state of store.listPluginStates()) {
        const plugin = state.active;
        if (!plugin || plugin.status !== "active" || !plugin.enabled) continue;
        const root = path.resolve(
          paths.pluginsRoot,
          plugin.id,
          "revisions",
          plugin.resolvedCommit,
        );
        if (!isInside(paths.pluginsRoot, root)) continue;
        try {
          const manifest = parsePluginManifest(
            JSON.parse(
              await readManifest(path.join(root, "allinai-plugin.json")),
            ),
          );
          const capability = manifest?.capabilities?.find(
            (item) => item.id === capabilityId,
          );
          if (!capability) continue;
          return {
            plugin,
            capability: capability as ShellCapability,
            pluginRoot: root,
          };
        } catch {
          continue;
        }
      }
      return null;
    },
    invoke(
      resolved: { capability: ShellCapability; pluginRoot: string },
      input: unknown,
      context: Record<string, unknown>,
      signal: AbortSignal,
    ) {
      return new ShellCapabilityHost({
        pluginRoot: resolved.pluginRoot,
      }).invoke(resolved.capability, input, context, signal);
    },
  };
}

/**
 * Compose the local daemon once. The Unix control socket is acquired before
 * SQLite and transports, which makes it the single-instance lock per Agent
 * home. Shutdown closes control, transport, database, and active children.
 */
export async function createLocalAgentDaemon(
  options: LocalAgentDaemonOptions = {},
): Promise<LocalAgentDaemon> {
  const paths = options.configDir
    ? agentPaths({ configDir: options.configDir })
    : resolveAgentPaths(options.homeDir);
  const loadConfig = options.loadConfig ?? ((input) => loadAgentConfig(input));
  const config = loadConfig(paths);
  const makeDir = options.mkdir ?? mkdir;
  await Promise.all([
    makeDir(paths.home, { recursive: true }),
    makeDir(paths.pluginsRoot, { recursive: true }),
    makeDir(paths.runsRoot, { recursive: true }),
    makeDir(paths.logsRoot, { recursive: true }),
  ]);

  let state: "starting" | "ok" | "degraded" | "unpaired" = "starting";
  let store: ClientStateStore | null = null;
  let supervisor: ClientSupervisor | null = null;
  let runner: RunnerManager | null = null;
  let closed = false;
  let resolveShutdown: (() => void) | null = null;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const server = await (options.createControlServer ?? startAgentControlServer)(
    {
      paths,
      platform: options.platform,
      control: {
        health: () => ({ status: state === "starting" ? "degraded" : state }),
        status: () => ({
          state,
          executions:
            store?.listExecutions().map((execution) => ({
              executionId: execution.executionId,
              state: execution.state,
              runtime:
                execution.command.kind === "agent.run"
                  ? execution.command.runtime
                  : undefined,
            })) ?? [],
          plugins:
            store?.listPluginStates().map((plugin) => plugin.plugin) ?? [],
        }),
        approve: async (executionId) => {
          if (!supervisor) throw new Error("Agent daemon is still starting");
          await supervisor.approve(executionId);
        },
        sync: async () => {
          if (!supervisor) throw new Error("Agent daemon is still starting");
          await supervisor.flush();
        },
      },
    },
  );

  try {
    store = (options.createStore ?? ((file) => new ClientStateStore(file)))(
      paths.stateDb,
    );
    store.markRecoveryRequired();
    const plugins = new PluginManager({
      pluginsRoot: paths.pluginsRoot,
      allowedGitOrigins: config.policy.allowedGitOrigins,
      stateStore: store,
    });
    runner = (options.createRunner ?? createRunnerManager)();
    const token = await (
      options.credentials ?? createCredentialStore({ paths })
    ).load(config.clientId);
    const transport: ClientTransport = token
      ? observeTransport(
          (
            options.createTransport ?? ((input) => new WsClientTransport(input))
          )({
            hubBaseUrl: config.hubBaseUrl,
            token,
            clientId: config.clientId,
          }),
          () => {
            state = "ok";
          },
          () => {
            if (!closed) state = "degraded";
          },
        )
      : unpairedTransport();
    if (!token) state = "unpaired";
    else state = "degraded";

    const localCapabilityPolicy = {
      clientEnabled: true,
      autoPermissions: config.policy.autoPermissions.filter(
        (permission): permission is "network" | "workspace:write" =>
          permission === "network" || permission === "workspace:write",
      ),
      allowedGitOrigins: config.policy.allowedGitOrigins,
      deniedPluginIds: config.policy.deniedPluginIds,
      allowedWorkspaceRoots: config.policy.allowedWorkspaceRoots,
    };
    const logger = createRotatingJsonlLogger({ logsRoot: paths.logsRoot });
    setBridgeLogger({
      debug: (tag, message, meta) =>
        void logger.write({ level: "debug", tag, message, ...meta }),
      info: (tag, message, meta) =>
        void logger.write({ level: "info", tag, message, ...meta }),
      warn: (tag, message, meta) =>
        void logger.write({ level: "warn", tag, message, ...meta }),
    });
    supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      maxConcurrentRuns: config.maxConcurrentRuns,
      plugins,
      capabilityHost: capabilityHost(
        store,
        paths,
        options.readPluginManifest ?? ((file) => readFile(file, "utf8")),
      ),
      capabilityPolicy: localCapabilityPolicy,
      policy: async (command) =>
        config.policy.autoRuntimes.includes(command.runtime)
          ? "auto"
          : "approval",
      // The Hub never chooses cwd. A single locally configured workspace root
      // is the only unambiguous local context available to this standalone CLI.
      capabilityContext: () => ({
        workspace:
          config.policy.allowedWorkspaceRoots.length === 1
            ? config.policy.allowedWorkspaceRoots[0]
            : undefined,
      }),
    });
    await supervisor.start();
  } catch (error) {
    await server.close();
    store?.close();
    throw error;
  }

  const onSignal = () => resolveShutdown?.();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return {
    async health() {
      return { status: state === "starting" ? "degraded" : state };
    },
    async status() {
      return {
        state,
        executions: store!.listExecutions(),
        plugins: store!.listPluginStates(),
      };
    },
    async sync() {
      await supervisor!.flush();
    },
    wait: () => shutdown,
    async close() {
      if (closed) return;
      closed = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await supervisor!.shutdown();
      store!.close();
      await server.close();
    },
  };
}

function unpairedTransport(): ClientTransport {
  return {
    async connect() {},
    async push() {
      return {};
    },
    async close() {},
  };
}

function observeTransport(
  transport: ClientTransport,
  connected: () => void,
  disconnected: () => void,
): ClientTransport {
  return {
    async connect(handlers) {
      await transport.connect({
        ...handlers,
        connected: async () => {
          connected();
          await handlers.connected();
        },
      });
    },
    push: (events) => transport.push(events),
    reportPluginSync: (acknowledgement) =>
      transport.reportPluginSync?.(acknowledgement) ?? Promise.resolve(),
    async close() {
      disconnected();
      await transport.close();
    },
  };
}

async function readConfigIfExists(file: string): Promise<AgentConfig | null> {
  try {
    return parseAgentConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}
