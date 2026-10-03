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
  fs?: CredentialFileSystem;
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

/**
 * The only credential store, identical on every platform: one mode-0600 file
 * per clientId under the Agent home, written atomically (temp file + rename).
 */
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
        throw new Error(`Credential file ${file} must have mode 0600`);
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

export function createCredentialStore(
  options: CredentialStoreOptions = {},
): CredentialStore {
  const paths = options.paths ?? resolveAgentPaths(options.homeDir);
  return new FileCredentialStore(paths.credentialsRoot, options.fs ?? credentialFs);
}
