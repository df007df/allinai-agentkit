import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveAgentPaths, type AgentPaths } from "./paths.js";

export type CredentialStore = {
  load(clientId: string): Promise<string | null>;
  save(clientId: string, token: string): Promise<void>;
  clear(clientId: string): Promise<void>;
};

export type SecurityCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Process port: tests can verify the exact security invocation without spawning a process. */
export type SecurityExecutor = (
  file: string,
  args: string[],
) => Promise<SecurityCommandResult>;

export type CredentialFileSystem = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  readFile(file: string, encoding: "utf8"): Promise<string>;
  writeFile(
    file: string,
    data: string,
    options: { encoding: "utf8"; mode: number; flag: "wx" },
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  stat(file: string): Promise<{ mode: number }>;
};

export type CredentialStoreOptions = {
  homeDir?: string;
  paths?: Pick<AgentPaths, "credentialsRoot">;
  platform?: NodeJS.Platform;
  executor?: SecurityExecutor;
  fs?: CredentialFileSystem;
  serviceName?: string;
};

const credentialFs: CredentialFileSystem = {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  chmod,
  stat,
};

// Deliberately the pre-rename identity: existing macOS keychain entries were
// written under this service name, and changing it would force every paired
// client to re-login after upgrade.
const KEYCHAIN_SERVICE = "allinai-agent";

function credentialFileName(clientId: string): string {
  if (!clientId.trim())
    throw new TypeError("clientId must be a nonempty string");
  return `${encodeURIComponent(clientId)}.token`;
}

function credentialFilePath(root: string, clientId: string): string {
  return path.join(root, credentialFileName(clientId));
}

function missingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function keychainUnavailable(
  error: unknown,
  platform: NodeJS.Platform,
): boolean {
  if (platform !== "darwin") return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return true;
  }
  const message =
    typeof error === "object" && error !== null && "stderr" in error
      ? `${String((error as { stdout?: unknown }).stdout ?? "")} ${String((error as { stderr?: unknown }).stderr ?? "")}`.toLowerCase()
      : messageOf(error).toLowerCase();
  return (
    message.includes("keychain is not available") ||
    message.includes("no keychain")
  );
}

function keychainItemMissing(result: SecurityCommandResult): boolean {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return text.includes("could not be found") || text.includes("item not found");
}

function defaultSecurityExecutor(): SecurityExecutor {
  return async (file, args) => {
    const { execFile } = await import("node:child_process");
    return await new Promise<SecurityCommandResult>((resolve, reject) => {
      execFile(file, args, { shell: false }, (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          reject(error);
          return;
        }
        resolve({
          code:
            typeof (error as { code?: unknown } | null)?.code === "number"
              ? (error as { code: number }).code
              : 0,
          stdout,
          stderr,
        });
      });
    });
  };
}

async function deleteIfPresent(
  fs: CredentialFileSystem,
  file: string,
): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (!missingFile(error)) throw error;
  }
}

class FileCredentialStore implements CredentialStore {
  constructor(
    private readonly root: string,
    private readonly fs: CredentialFileSystem,
  ) {}

  async load(clientId: string): Promise<string | null> {
    const file = credentialFilePath(this.root, clientId);
    try {
      const info = await this.fs.stat(file);
      if ((info.mode & 0o077) !== 0) {
        throw new Error(`Credential fallback file ${file} must have mode 0600`);
      }
      const token = (await this.fs.readFile(file, "utf8")).trim();
      return token || null;
    } catch (error) {
      if (missingFile(error)) return null;
      throw error;
    }
  }

  async save(clientId: string, token: string): Promise<void> {
    if (!token.trim()) throw new TypeError("token must be a nonempty string");
    await this.fs.mkdir(this.root, { recursive: true });
    const file = credentialFilePath(this.root, clientId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(temporary, token, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await this.fs.chmod(temporary, 0o600);
      await this.fs.rename(temporary, file);
      await this.fs.chmod(file, 0o600);
    } catch (error) {
      await deleteIfPresent(this.fs, temporary);
      throw error;
    }
  }

  async clear(clientId: string): Promise<void> {
    await deleteIfPresent(this.fs, credentialFilePath(this.root, clientId));
  }
}

class KeychainCredentialStore implements CredentialStore {
  private readonly fallback: FileCredentialStore;

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly executor: SecurityExecutor,
    paths: Pick<AgentPaths, "credentialsRoot">,
    fs: CredentialFileSystem,
    private readonly serviceName: string,
  ) {
    this.fallback = new FileCredentialStore(paths.credentialsRoot, fs);
  }

  async load(clientId: string): Promise<string | null> {
    if (this.platform !== "darwin") return this.fallback.load(clientId);
    try {
      const result = await this.executor("security", [
        "find-generic-password",
        "-a",
        clientId,
        "-s",
        this.serviceName,
        "-w",
      ]);
      if (result.code === 0) return result.stdout.trim() || null;
      // A functioning Keychain is authoritative. Do not silently prefer an
      // old fallback file merely because this account has no Keychain item.
      if (keychainItemMissing(result)) return null;
      if (keychainUnavailable(result, this.platform))
        return this.fallback.load(clientId);
      throw new Error(
        `Keychain load failed: ${result.stderr || result.stdout || result.code}`,
      );
    } catch (error) {
      if (keychainUnavailable(error, this.platform))
        return this.fallback.load(clientId);
      throw error;
    }
  }

  async save(clientId: string, token: string): Promise<void> {
    if (!token.trim()) throw new TypeError("token must be a nonempty string");
    if (this.platform !== "darwin") return this.fallback.save(clientId, token);
    try {
      const result = await this.executor("security", [
        "add-generic-password",
        "-U",
        "-a",
        clientId,
        "-s",
        this.serviceName,
        "-w",
        token,
      ]);
      if (result.code === 0) return;
      if (keychainUnavailable(result, this.platform))
        return this.fallback.save(clientId, token);
      throw new Error(
        `Keychain save failed: ${result.stderr || result.stdout || result.code}`,
      );
    } catch (error) {
      if (keychainUnavailable(error, this.platform))
        return this.fallback.save(clientId, token);
      throw error;
    }
  }

  async clear(clientId: string): Promise<void> {
    if (this.platform !== "darwin") return this.fallback.clear(clientId);
    try {
      const result = await this.executor("security", [
        "delete-generic-password",
        "-a",
        clientId,
        "-s",
        this.serviceName,
      ]);
      if (result.code === 0 || keychainItemMissing(result)) {
        await this.fallback.clear(clientId);
        return;
      }
      if (keychainUnavailable(result, this.platform))
        return this.fallback.clear(clientId);
      throw new Error(
        `Keychain clear failed: ${result.stderr || result.stdout || result.code}`,
      );
    } catch (error) {
      if (keychainUnavailable(error, this.platform))
        return this.fallback.clear(clientId);
      throw error;
    }
  }
}

/**
 * Keychain is preferred on macOS. A mode-0600, atomic local file is used only
 * when Keychain itself is unavailable (or on a platform without Keychain).
 */
export function createCredentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  const paths = options.paths ?? resolveAgentPaths(options.homeDir);
  return new KeychainCredentialStore(
    options.platform ?? process.platform,
    options.executor ?? defaultSecurityExecutor(),
    paths,
    options.fs ?? credentialFs,
    options.serviceName ?? KEYCHAIN_SERVICE,
  );
}
