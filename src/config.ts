import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentPaths } from "./paths.js";

export type AgentLocalPolicy = {
  /**
   * When true every agent run waits for a local execution approval; false
   * (the default) lets runs start immediately.
   */
  requireRunApproval: boolean;
  autoPermissions: string[];
  allowedGitOrigins: string[];
  deniedPluginIds: string[];
  allowedWorkspaceRoots: string[];
};

/**
 * A locally registered project name and its working directory. `dir` is the
 * random suffix generated at registration time that names the project's
 * session-record root (projects/<name>-<dir>) — stable across restarts, so
 * re-registering the same name starts a new record epoch.
 */
export type AgentProject = {
  name: string;
  path: string;
  dir: string;
};

export type SkillRepo = {
  /** Plugin id; conventionally prefixed "skills-" for identification. */
  id: string;
  gitUrl: string;
  ref?: string;
};

export type AgentConfig = {
  hubBaseUrl: string;
  clientId: string;
  /** Human-readable display name; shown on authorize pages and consoles. */
  name?: string;
  /**
   * Proxy URL (http(s)://host:port) forwarded to agent runtime children so
   * platform SDKs reach their APIs through the same proxy as this shell.
   * Absent means "inherit the daemon's environment as-is".
   */
  proxy?: string;
  maxConcurrentRuns: number;
  policy: AgentLocalPolicy;
  /** Locally owned project registry; Hub payloads select a project by name. */
  projects: AgentProject[];
  /**
   * Locally configured skill repositories, synced as plugins through the
   * standard plugin pipeline. Hub plugin.sync entries with the same id
   * override these (hub is the online source of truth; local entries keep
   * skills available offline).
   */
  skillsRepos: SkillRepo[];
};

export type ConfigFileSystem = {
  readFile(file: string, encoding: "utf8"): string;
};

export type ConfigWriter = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(
    file: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ): Promise<void>;
};

const DEFAULT_POLICY: Readonly<AgentLocalPolicy> = Object.freeze({
  requireRunApproval: false,
  autoPermissions: [],
  allowedGitOrigins: [],
  deniedPluginIds: [],
  allowedWorkspaceRoots: [],
});

function clonePolicy(policy = DEFAULT_POLICY): AgentLocalPolicy {
  return {
    requireRunApproval: policy.requireRunApproval,
    autoPermissions: [...policy.autoPermissions],
    allowedGitOrigins: [...policy.allowedGitOrigins],
    deniedPluginIds: [...policy.deniedPluginIds],
    allowedWorkspaceRoots: [...policy.allowedWorkspaceRoots],
  };
}

/** Defaults apply only to bounded local settings; Hub identity remains explicit. */
export function defaultAgentConfig(): Pick<
  AgentConfig,
  "maxConcurrentRuns" | "policy" | "projects" | "skillsRepos"
> {
  return {
    maxConcurrentRuns: 1,
    policy: clonePolicy(),
    projects: [],
    skillsRepos: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROXY_URL_PATTERN = /^https?:\/\/[^\s/]+(:\d+)?$/;

/** Validated http(s) proxy endpoint; no path, no query. */
function parseProxyUrl(value: unknown): string {
  const raw = requireString(value, "proxy");
  if (!PROXY_URL_PATTERN.test(raw)) {
    throw new TypeError(
      "proxy must be an http(s) URL like http://127.0.0.1:7900 (host[:port] only)",
    );
  }
  return raw;
}

function requireString(
  value: unknown,
  name: string,
  options?: { allowEmpty?: boolean },
): string {
  if (
    typeof value !== "string" ||
    (!options?.allowEmpty && value.trim().length === 0)
  ) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value.trim();
}

function stringArray(
  value: unknown,
  name: string,
  fallback: string[],
): string[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new TypeError(`${name} must be an array of nonempty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function parseBooleanFlag(
  value: unknown,
  name: string,
  fallback: boolean,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new TypeError(`${name} must be a boolean`);
  return value;
}

function parsePolicy(value: unknown): AgentLocalPolicy {
  if (value === undefined) return clonePolicy();
  if (!isRecord(value)) throw new TypeError("policy must be an object");
  const allowed = new Set(Object.keys(DEFAULT_POLICY));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`policy.${key} is not supported`);
  }
  return {
    requireRunApproval: parseBooleanFlag(
      value.requireRunApproval,
      "policy.requireRunApproval",
      DEFAULT_POLICY.requireRunApproval,
    ),
    autoPermissions: stringArray(
      value.autoPermissions,
      "policy.autoPermissions",
      [],
    ),
    allowedGitOrigins: stringArray(
      value.allowedGitOrigins,
      "policy.allowedGitOrigins",
      [],
    ),
    deniedPluginIds: stringArray(
      value.deniedPluginIds,
      "policy.deniedPluginIds",
      [],
    ),
    allowedWorkspaceRoots: stringArray(
      value.allowedWorkspaceRoots,
      "policy.allowedWorkspaceRoots",
      [],
    ),
  };
}

const PROJECT_DIR_PATTERN = /^[0-9a-f]{6}$/;

/** Projects must be locally absolute directories with unique names and a record suffix. */
export function parseSkillRepos(value: unknown): SkillRepo[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError("skillsRepos must be an array of { id, gitUrl, ref? }");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !entry.id.trim() ||
      typeof entry.gitUrl !== "string" ||
      entry.gitUrl.trim().length === 0 ||
      (entry.ref !== undefined && typeof entry.ref !== "string")
    ) {
      throw new TypeError(
        "skillsRepos entries must be objects with nonempty id and gitUrl strings and an optional ref",
      );
    }
    const id = entry.id.trim();
    if (ids.has(id)) {
      throw new TypeError(`skillsRepos id ${id} is duplicated`);
    }
    ids.add(id);
    return {
      id,
      gitUrl: entry.gitUrl.trim(),
      ...(typeof entry.ref === "string" && entry.ref.trim()
        ? { ref: entry.ref.trim() }
        : {}),
    };
  });
}

export function parseProjects(value: unknown): AgentProject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new TypeError("projects must be an array of { name, path, dir }");
  const names = new Set<string>();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.name !== "string" ||
      entry.name.trim().length === 0 ||
      typeof entry.path !== "string" ||
      entry.path.trim().length === 0 ||
      typeof entry.dir !== "string" ||
      !PROJECT_DIR_PATTERN.test(entry.dir)
    ) {
      throw new TypeError(
        "projects entries must be objects with nonempty name and path strings and a 6-hex-char dir suffix",
      );
    }
    if (!path.isAbsolute(entry.path.trim())) {
      throw new TypeError(
        `Project ${entry.name} path must be an absolute directory`,
      );
    }
    const name = entry.name.trim();
    if (names.has(name)) {
      throw new TypeError(`Project name ${name} is duplicated`);
    }
    names.add(name);
    return {
      name,
      path: path.resolve(entry.path.trim()),
      dir: entry.dir,
    };
  });
}

function parseHubBaseUrl(value: unknown): string {
  const raw = requireString(value, "hubBaseUrl");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("hubBaseUrl must be an absolute http or https URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    throw new TypeError("hubBaseUrl must be an absolute http or https URL");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

/** Strictly validate config.json and supply only safe local defaults. */
export function parseAgentConfig(value: unknown): AgentConfig {
  if (!isRecord(value))
    throw new TypeError("Agent config must be a JSON object");
  const allowed = new Set([
    "hubBaseUrl",
    "clientId",
    "name",
    "proxy",
    "maxConcurrentRuns",
    "policy",
    "projects",
    "skillsRepos",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`Agent config field ${key} is not supported`);
  }
  const defaults = defaultAgentConfig();
  const maxConcurrentRuns =
    value.maxConcurrentRuns ?? defaults.maxConcurrentRuns;
  if (
    !Number.isInteger(maxConcurrentRuns) ||
    (maxConcurrentRuns as number) < 1 ||
    (maxConcurrentRuns as number) > 32
  ) {
    throw new RangeError(
      "maxConcurrentRuns must be an integer between 1 and 32",
    );
  }
  const name =
    value.name === undefined ? undefined : requireString(value.name, "name");
  const proxy =
    value.proxy === undefined ? undefined : parseProxyUrl(value.proxy);
  return {
    hubBaseUrl: parseHubBaseUrl(value.hubBaseUrl),
    clientId: requireString(value.clientId, "clientId"),
    ...(name ? { name } : {}),
    ...(proxy ? { proxy } : {}),
    maxConcurrentRuns: maxConcurrentRuns as number,
    policy: parsePolicy(value.policy),
    projects: parseProjects(value.projects),
    skillsRepos: parseSkillRepos(value.skillsRepos),
  };
}

/** Read exactly the client-owned config file. Missing/invalid files are explicit failures. */
export function loadAgentConfig(
  paths: Pick<AgentPaths, "configFile">,
  fs: ConfigFileSystem = { readFile: readFileSync },
): AgentConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFile(paths.configFile, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read agent config at ${paths.configFile}: ${message}`,
    );
  }
  return parseAgentConfig(raw);
}

/**
 * Persist the non-secret pairing configuration in the Agent-owned home.
 * Pairing credentials must be written separately through CredentialStore.
 */
export async function saveAgentConfig(
  paths: Pick<AgentPaths, "home" | "configFile">,
  config: AgentConfig,
  fs: ConfigWriter = { mkdir, writeFile },
): Promise<void> {
  const normalized = parseAgentConfig(config);
  await fs.mkdir(paths.home, { recursive: true });
  await fs.writeFile(
    paths.configFile,
    `${JSON.stringify(normalized, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}
