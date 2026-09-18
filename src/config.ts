import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AgentPaths } from "./paths.js";

export type AgentLocalPolicy = {
  autoRuntimes: string[];
  autoPermissions: string[];
  allowedGitOrigins: string[];
  deniedPluginIds: string[];
  allowedWorkspaceRoots: string[];
};

export type AgentConfig = {
  hubBaseUrl: string;
  clientId: string;
  maxConcurrentRuns: number;
  policy: AgentLocalPolicy;
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
  autoRuntimes: [],
  autoPermissions: [],
  allowedGitOrigins: [],
  deniedPluginIds: [],
  allowedWorkspaceRoots: [],
});

function clonePolicy(policy = DEFAULT_POLICY): AgentLocalPolicy {
  return {
    autoRuntimes: [...policy.autoRuntimes],
    autoPermissions: [...policy.autoPermissions],
    allowedGitOrigins: [...policy.allowedGitOrigins],
    deniedPluginIds: [...policy.deniedPluginIds],
    allowedWorkspaceRoots: [...policy.allowedWorkspaceRoots],
  };
}

/** Defaults apply only to bounded local settings; Hub identity remains explicit. */
export function defaultAgentConfig(): Pick<
  AgentConfig,
  "maxConcurrentRuns" | "policy"
> {
  return { maxConcurrentRuns: 1, policy: clonePolicy() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parsePolicy(value: unknown): AgentLocalPolicy {
  if (value === undefined) return clonePolicy();
  if (!isRecord(value)) throw new TypeError("policy must be an object");
  const allowed = new Set(Object.keys(DEFAULT_POLICY));
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new TypeError(`policy.${key} is not supported`);
  }
  return {
    autoRuntimes: stringArray(value.autoRuntimes, "policy.autoRuntimes", []),
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
    "maxConcurrentRuns",
    "policy",
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
  return {
    hubBaseUrl: parseHubBaseUrl(value.hubBaseUrl),
    clientId: requireString(value.clientId, "clientId"),
    maxConcurrentRuns: maxConcurrentRuns as number,
    policy: parsePolicy(value.policy),
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
