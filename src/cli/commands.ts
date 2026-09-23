import { mkdir, readFile, watch, writeFile } from "node:fs/promises";
import { readFileSync as readFileSyncText, statSync as statFileSync } from "node:fs";
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
import {
  createRotatingJsonlLogger,
  bridgeLog,
  setBridgeLogger,
} from "../logger.js";
import { resolveAgentPaths, type AgentPaths } from "../paths.js";
import { renderManualMarkdown, cliManual } from "./docs.js";
import { installCodexHooks } from "../codex-hooks.js";
import {
  startToolApprovalHttpBridge,
  ToolApprovalDecisionMap,
  type ToolApprovalHttpBridge,
} from "../control-http.js";
import { PluginManager } from "../plugins/manager.js";
import { parsePluginManifest } from "../plugins/manifest.js";
import {
  prepareExecutionWorkspace,
  projectDirectorySuffix,
  projectRecordDir,
} from "../workspace/workspace.js";
import { SessionRecorder } from "../workspace/session-recorder.js";
import { ShellCapabilityHost } from "../capabilities/shell-host.js";
import type { ShellCapability } from "../capabilities/types.js";
import { ClientStateStore } from "../client/state-store.js";
import { ClientSupervisor } from "../client/supervisor.js";
import type {
  ProjectDirectory,
  ProjectDirectoryResolver,
} from "../client/supervisor.js";
import type { ClientTransport } from "../client/transport.js";
import { WsClientTransport } from "../client/ws-transport.js";
import type {
  InventoryReport,
  PlatformInventoryEntry,
} from "../protocol/index.js";
import {
  createPlatformAdapterRegistry,
  createRunnerManager,
  type PlatformProbe,
  type RegisteredPlatformAdapter,
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
  /** Loopback URL of the tool-approval hook bridge, or null when absent. */
  toolApprovalBridgeUrl: string | null;
};

export type UserServiceInput = {
  platform: NodeJS.Platform;
  homeDir: string;
  configDir: string;
  executable: string;
};

/**
 * Minimal shape the `web` command needs from a running console site. The
 * in-repo startConsoleServer also returns `runtime`; the extra field is
 * structurally compatible, so that implementation satisfies this contract.
 */
export type ConsoleSiteHandle = {
  url: string;
  hubUrl: string;
  close(): Promise<void>;
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
  startConsoleSite?: (options: {
    port?: number;
    host?: string;
  }) => Promise<ConsoleSiteHandle>;
  /** Resolves when the web command should shut down; injectable so tests never hang. */
  webWaiter?: () => Promise<void>;
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
  /**
   * Test seam for the loopback HTTP bridge that the Codex PreToolUse hook
   * posts approvals to; replacing it keeps daemon tests off the network.
   */
  startToolApprovalBridge?: typeof startToolApprovalHttpBridge;
  loadConfig?: (paths: Pick<AgentPaths, "configFile">) => AgentConfig;
  /** Same shape as RunCliOptions.probeRuntimes; backs the inventory provider. */
  probeRuntimes?: () => Promise<RuntimeProbeResult[]>;
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
 * wrong client instance. Exported so docs.test.ts can hold the manual in
 * lockstep with what runCli actually accepts.
 */
export const COMMAND_OPTIONS: Readonly<Record<string, CommandOptionSpec>> = {
  init: { values: ["hub", "client", "token", "config-dir"] },
  login: {
    values: ["hub", "client", "name", "config-dir"],
    booleans: ["no-browser"],
  },
  web: { values: ["port", "host", "config-dir"] },
  daemon: { values: ["config-dir"] },
  install: { values: ["config-dir"] },
  "codex-hooks": { values: ["control-endpoint", "codex-home", "config-dir"] },
  status: { values: ["config-dir"] },
  logs: { values: ["config-dir"], booleans: ["f"] },
  sync: { values: ["config-dir"] },
  restart: { values: ["config-dir"] },
  uninstall: { values: ["config-dir"] },
  doctor: { values: ["config-dir"] },
  projects: { values: ["config-dir"] },
  project: {
    values: ["name", "path", "config-dir"],
    booleans: ["remove"],
  },
  plugins: { values: ["config-dir"], booleans: ["refresh"] },
  docs: { booleans: ["json"] },
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
  return options.executable ?? process.argv[1] ?? "allinai-agentkit";
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

async function defaultWhich(name: string): Promise<string | null> {
  const { execFile } = await import("node:child_process");
  return await new Promise<string | null>((resolve) => {
    execFile("which", [name], { shell: false }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(String(stdout).trim() || null);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A missing optional runtime SDK is a normal condition, not a daemon failure:
 * one rejecting probe degrades that platform to `installed: false` so the
 * remaining platforms stay visible in the inventory.
 */
async function probeOrUnavailable(
  adapter: RegisteredPlatformAdapter,
): Promise<RuntimeProbeResult> {
  try {
    return { id: adapter.id, probe: await adapter.probe() };
  } catch (error) {
    return {
      id: adapter.id,
      probe: { installed: false, version: null, reason: errorMessage(error) },
    };
  }
}

async function defaultProbeRuntimes(): Promise<RuntimeProbeResult[]> {
  const registry = createPlatformAdapterRegistry();
  return await Promise.all(registry.list().map(probeOrUnavailable));
}

/** Follow only the client-owned JSONL file and stream appended lines as-is. */
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
    if (appended) write(appended);
  }
}

function help(): string {
  return [
    "Usage: allinai-agentkit <init|login|web|daemon|install|codex-hooks|status|logs|sync|restart|uninstall|doctor|projects|project|plugins|docs> [--config-dir PATH]",
    "  project --name NAME --path DIR   register a local project working directory",
    "  project --name NAME --remove     remove a registered project",
    "  plugins [--refresh]              list installed plugins; --refresh re-reports them to the Hub",
    "  codex-hooks                      install the Codex PreToolUse approval hook (then trust it via /hooks in codex)",
    "  docs [--json]                    print the full CLI manual (Markdown; --json for structured output)",
  ].join("\n");
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

    if (command === "docs") {
      const manual = cliManual();
      emit(
        output,
        write,
        parsed.flags.get("json") === true
          ? JSON.stringify(manual)
          : renderManualMarkdown(manual),
      );
      return { exitCode: 0, output };
    }

    if (command === "login") {
      const hubBaseUrl = flagValue(parsed.flags, "hub");
      if (!hubBaseUrl)
        throw new Error("login requires --hub http://127.0.0.1:4317");
      const noBrowser = parsed.flags.get("no-browser") === true;
      const existing = await readConfigIfExists(paths.configFile);
      // The client owns its identity: an explicit --client overrides, else the
      // persisted one stands, else it is generated here once and saved with the
      // config so every later command and the daemon reuse the same id.
      const clientId =
        flagValue(parsed.flags, "client") ?? existing?.clientId ?? randomUUID();
      // --name names the client for humans (authorize page, console list).
      const name = flagValue(parsed.flags, "name");
      await mkdir(paths.home, { recursive: true });
      const result = await runLoginFlow({
        hubBaseUrl,
        clientId,
        ...(name ? { name } : {}),
        credentials:
          scopedOptions.credentials ?? createCredentialStore({ paths }),
        saveConfig: async (input) => {
          const config = parseAgentConfig({
            ...(existing ?? defaultAgentConfig()),
            hubBaseUrl: input.hubBaseUrl,
            clientId: input.clientId,
            ...(name ? { name } : existing?.name ? { name: existing.name } : {}),
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

    if (command === "web") {
      const portFlag = flagValue(parsed.flags, "port");
      const port = portFlag === undefined ? undefined : Number(portFlag);
      if (
        port !== undefined &&
        (!Number.isInteger(port) || port < 0 || port > 65535)
      ) {
        throw new Error("--port must be an integer between 0 and 65535");
      }
      const host = flagValue(parsed.flags, "host");
      const site = await (
        scopedOptions.startConsoleSite ?? startConsoleWebSite
      )({ port, host });
      emit(output, write, {
        consoleUrl: site.url,
        // startWebHost may report only the console URL; derive the Hub
        // WebSocket endpoint from it when the package does not provide one.
        hubWsUrl: site.hubUrl ?? site.url.replace(/^http/, "ws"),
      });
      const wait = scopedOptions.webWaiter ?? waitForShutdownSignal;
      try {
        await wait();
      } finally {
        await site.close();
      }
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

    if (command === "codex-hooks") {
      const endpoint = flagValue(parsed.flags, "control-endpoint") ?? "http://127.0.0.1:8787";
      const codexHome = flagValue(parsed.flags, "codex-home");
      const result = installCodexHooks({ controlEndpoint: endpoint, codexHome });
      emit(output, write, {
        installed: true,
        hooksPath: result.hooksPath,
        scriptPath: result.scriptPath,
        merged: result.merged,
        nextStep: result.trustNote,
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
      if (content) emit(output, write, content.trimEnd());
      if (follow) {
        await (scopedOptions.followLog ?? defaultFollowLog)(
          logFile,
          write,
          scopedOptions.signal,
        );
      }
      return { exitCode: 0, output };
    }
    if (command === "projects") {
      const config = loadAgentConfig(paths);
      emit(output, write, {
        projects: config.projects,
        defaultHint:
          "agent.run 不带 project 字段时使用 runner 默认目录；带 project 时使用此处注册的目录",
      });
      return { exitCode: 0, output };
    }

    if (command === "project") {
      const name = flagValue(parsed.flags, "name");
      const projectPath = flagValue(parsed.flags, "path");
      const remove = parsed.flags.get("remove") === true;
      if (!name) throw new Error("project requires --name NAME");
      if (remove && projectPath)
        throw new Error("--path cannot be combined with --remove");
      if (!remove && !projectPath)
        throw new Error("project requires --path DIR (or --remove)");

      const existing = await readConfigIfExists(paths.configFile);
      if (!existing) throw new Error(`No agent config at ${paths.configFile}`);
      const projects = existing.projects.filter(
        (project) => project.name !== name,
      );
      let recordDir: string | undefined;
      if (!remove) {
        // Validate the raw operator input before any cwd-relative resolution
        // could silently turn a relative path into one inside the CLI process.
        if (!path.isAbsolute(projectPath!.trim()))
          throw new Error("--path must be an absolute directory");
        // The suffix names the session-record root (projects/<name>-<dir>) and
        // persists in config: re-registering the same name opens a new epoch
        // instead of silently reusing the previous epoch's sessions.
        recordDir = projectDirectorySuffix();
        projects.push({
          name,
          path: path.resolve(projectPath!.trim()),
          dir: recordDir,
        });
      }
      const config = parseAgentConfig({ ...existing, projects });
      await mkdir(paths.home, { recursive: true });
      await writeFile(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      emit(output, write, {
        registered: !remove,
        removed: remove,
        name,
        recordDir,
        projects: config.projects,
        restartHint: remove
          ? undefined
          : "运行中的 daemon 在下一条 agent.run 时读取最新配置；也可执行 restart 立即生效",
      });
      return { exitCode: 0, output };
    }

    if (command === "plugins") {
      const refresh = parsed.flags.get("refresh") === true;
      if (!control.plugins)
        throw new Error("This daemon does not expose plugins");
      const plugins = await control.plugins();
      if (refresh) {
        if (!control.refreshPlugins)
          throw new Error("This daemon does not support plugin refresh");
        await control.refreshPlugins();
      }
      emit(output, write, { plugins, refreshed: refresh });
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

/**
 * Default `web` starter: @allin-ai/agentkit-web is an optional peer package
 * (Task 12 provides it inside this repo's devDependencies). When it is absent,
 * the dynamic import fails and the operator gets an actionable install hint
 * instead of a stack trace.
 */
async function startConsoleWebSite(options: {
  port?: number;
  host?: string;
}): Promise<ConsoleSiteHandle> {
  // Widened on purpose: the package is an optional peer (Task 12), so the
  // specifier must stay a runtime string or tsc would reject its absence.
  const specifier = "@allin-ai/agentkit-web/server";
  const mod = (await import(specifier).catch(() => null)) as {
    startWebHost?: (options: {
      port?: number;
      host?: string;
    }) => Promise<ConsoleSiteHandle>;
  } | null;
  if (!mod?.startWebHost) {
    throw new Error(
      "Console UI not installed. Run: npm i @allin-ai/agentkit-web",
    );
  }
  return await mod.startWebHost({ port: options.port, host: options.host });
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

const INVENTORY_PROBE_TTL_MS = 60_000;

/**
 * Supplies local inventory to the supervisor's inventory reports. Platform
 * probes are cached briefly because every sync, connect, and Hub query
 * refreshes otherwise. A rejecting probe degrades that single platform to
 * `installed: false` (with the error as reason) so the remaining platforms
 * stay visible; the supervisor still degrades to an empty list if the
 * provider itself throws. The cache is only written after the probe batch
 * resolves so the next call retries.
 */
function createInventoryProvider(input: {
  store: ClientStateStore;
  probeRuntimes: () => Promise<RuntimeProbeResult[]>;
}): () => Promise<InventoryReport> {
  let cache: { at: number; platforms: PlatformInventoryEntry[] } | null = null;
  const toEntry = async ({
    id,
    probe,
  }: RuntimeProbeResult): Promise<PlatformInventoryEntry> => {
    let resolved: PlatformProbe;
    try {
      resolved = await probe;
    } catch (error) {
      resolved = {
        installed: false,
        version: null,
        reason: errorMessage(error),
      };
    }
    return {
      platform: id as PlatformInventoryEntry["platform"],
      installed: resolved.installed,
      version: resolved.version,
      ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
    };
  };
  return async () => {
    const now = Date.now();
    if (!cache || now - cache.at > INVENTORY_PROBE_TTL_MS) {
      const probes = await input.probeRuntimes();
      const platforms = await Promise.all(probes.map(toEntry));
      cache = { at: now, platforms };
    }
    const probed = cache;
    // The supervisor derives plugin entries from the store itself; the report
    // contract keeps plugins so the wire shape stays complete.
    return {
      type: "inventory.report",
      reportedAt: new Date().toISOString(),
      platforms: probed.platforms,
      plugins: [],
      // Live project names reach the report through the supervisor's
      // projectResolver; this provider contract keeps the wire shape complete.
      projects: [],
    };
  };
}

/**
 * Live view of the locally registered project registry. config.json is the
 * source of truth: every read stats the file and re-parses only when it
 * changed, so `project add` reaches a running daemon on its next agent.run or
 * inventory report without a restart. A config file that disappears or turns
 * invalid degrades to an empty registry (runs fall back to the default cwd)
 * rather than crashing the daemon mid-flight.
 */
export function createLiveProjectResolver(
  configFile: string,
  io: {
    loadConfig: (paths: Pick<AgentPaths, "configFile">) => AgentConfig;
    statSync?: (file: string) => { mtimeMs: number };
    readFileSync?: (file: string, encoding: "utf8") => string;
  },
  recordPaths?: AgentPaths,
): ProjectDirectoryResolver {
  const loadConfig = io.loadConfig;
  const statSync =
    io.statSync ?? ((file: string) => statFileSync(file) as { mtimeMs: number });
  const readFileSync =
    io.readFileSync ?? ((file: string, encoding: "utf8") => readFileSyncText(file, encoding));
  let cache: { mtimeMs: number; projects: ProjectDirectory[] } | null = null;

  const currentProjects = (): ProjectDirectory[] => {
    try {
      const { mtimeMs } = statSync(configFile);
      if (cache && cache.mtimeMs === mtimeMs) return cache.projects;
      // parseAgentConfig validates the whole document; project entries must be
      // absolute, unique, and well-formed before they can be resolved.
      const config = parseAgentConfig(JSON.parse(readFileSync(configFile, "utf8")));
      const projects = config.projects.map(({ name, path, dir }) => ({
        name,
        path,
        dir,
      }));
      cache = { mtimeMs, projects };
      return projects;
    } catch (error) {
      // A missing or invalid config must not take the daemon down mid-run:
      // fall back to the last good registry, else to empty (default cwd).
      if (cache) return cache.projects;
      bridgeLog.warn("daemon", "project_registry_unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };

  return {
    list() {
      return currentProjects();
    },
    resolve(name) {
      if (!name) return undefined;
      const projects = currentProjects();
      const project = projects.find((entry) => entry.name === name);
      if (!project) {
        bridgeLog.warn("daemon", "unknown project requested", { project: name });
        return undefined;
      }
      return {
        path: project.path,
        recordDir: recordPaths
          ? projectRecordDir(recordPaths, project)
          : undefined,
      };
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
  let approvalBridge: ToolApprovalHttpBridge | null = null;
  let logging: Promise<void> = Promise.resolve();
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
        respondToolApproval: async (
          executionId,
          requestId,
          decision,
          reason,
        ) => {
          if (!supervisor) throw new Error("Agent daemon is still starting");
          await supervisor.respondToolApproval(
            executionId,
            requestId,
            decision,
            reason,
          );
        },
        sync: async () => {
          if (!supervisor) throw new Error("Agent daemon is still starting");
          await supervisor.flush();
        },
        plugins: async () =>
          store?.listPluginStates().map((state) => state.plugin) ?? [],
        refreshPlugins: async () => {
          if (!supervisor) throw new Error("Agent daemon is still starting");
          await supervisor.refreshPlugins();
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
            ...(config.name ? { name: config.name } : {}),
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
    const writeLog = (
      level: "debug" | "info" | "warn",
      entry: Record<string, unknown>,
    ) => {
      // Writes are serialized and drained on close. Failure handling here is
      // deliberately local: once the test/CLI process has removed the config
      // dir, a rejected append must not surface as an unhandled rejection.
      logging = logging
        .then(() => logger.write(entry))
        .catch(() => undefined);
    };
    setBridgeLogger({
      debug: (tag, message, meta) =>
        writeLog("debug", { level: "debug", tag, message, ...meta }),
      info: (tag, message, meta) =>
        writeLog("info", { level: "info", tag, message, ...meta }),
      warn: (tag, message, meta) =>
        writeLog("warn", { level: "warn", tag, message, ...meta }),
    });
    // Loopback HTTP bridge for the Codex PreToolUse hook. The bridge is a
    // pure replay surface: it only echoes tool-approval decisions a human
    // already made (console offer channel or the local control socket — both
    // funnel through runner.respondToolApproval). The wrapped runner records
    // each decision in a bounded map; a hook POST with no recorded decision
    // denies fail-closed instead of auto-allowing (the old behavior leaked
    // allows to any local process).
    //
    // The wrapper is created BEFORE ClientSupervisor captures the runner, so
    // the supervisor's respondToolApproval path flows through it. Capability
    // is decided on the BASE runner: IsolatedRunnerManager exposes these as
    // prototype methods, which an object spread would drop from the wrapper.
    const baseRunner = runner;
    const approvalDecisions = new ToolApprovalDecisionMap();
    const supportsApprovalRelay =
      typeof baseRunner.respondToolApproval === "function" &&
      typeof baseRunner.ownerOfToolApproval === "function";
    if (supportsApprovalRelay) {
      runner = Object.create(baseRunner) as RunnerManager;
      runner.respondToolApproval = (
        executionId: string,
        requestId: string,
        decision: "allow" | "deny",
        reason?: string,
      ) => {
        approvalDecisions.record(requestId, decision, reason);
        baseRunner.respondToolApproval?.(
          executionId,
          requestId,
          decision,
          reason,
        );
      };
    }
    // Session records: every run whose PlatformRunInput carries a sessionDir
    // mirrors its state timeline under projects/<project>/sessions/<id>.
    // Wrapped after the approval relay so respondToolApproval stays intact.
    const sessionRecorder = new SessionRecorder();
    runner = sessionRecorder.wrapRunner(runner);
    supervisor = new ClientSupervisor({
      store,
      transport,
      runner,
      maxConcurrentRuns: config.maxConcurrentRuns,
      plugins,
      inventoryProvider: createInventoryProvider({
        store,
        probeRuntimes: options.probeRuntimes ?? defaultProbeRuntimes,
      }),
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
      // Projects are registered locally (CLI `project add`); a Hub run may
      // select one by name, and unknown names fall back to the runner default.
      // The registry is re-read from config.json at each use (mtime-cached), so
      // a running daemon picks up project registration without a restart.
      projectResolver: createLiveProjectResolver(
        paths.configFile,
        { loadConfig },
        paths,
      ),
      defaultWorkspace: {
        prepare: async ({ platform, executionId }) =>
          await prepareExecutionWorkspace({ paths, platform, executionId }),
      },
    });
    await supervisor.start();

    // Loopback HTTP bridge for the Codex PreToolUse hook. The bridge is a
    // pure replay surface: it only echoes tool-approval decisions a human
    // already made (console offer channel or the local control socket — both
    // funnel through runner.respondToolApproval). The wrapped runner records
    // each decision in a bounded map; a hook POST with no recorded decision
    // denies fail-closed instead of auto-allowing (the old behavior leaked
    // allows to any local process).
    if (supportsApprovalRelay) {
      try {
        approvalBridge = await (options.startToolApprovalBridge ??
          startToolApprovalHttpBridge)({
          resolveDecision: (requestId) => approvalDecisions.resolve(requestId),
        });
      } catch (error) {
        // The bridge is an optional convenience for hook-based approvals; a
        // listen failure (port taken, no loopback) must not fail daemon boot.
        bridgeLog.warn("daemon", "tool_approval_bridge_unavailable", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
    toolApprovalBridgeUrl: approvalBridge?.url ?? null,
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
      await approvalBridge?.close();
      await logging;
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
    reportInventory: (report) =>
      transport.reportInventory?.(report) ?? Promise.resolve(),
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
