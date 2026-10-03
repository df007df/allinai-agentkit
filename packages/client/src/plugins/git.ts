import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

type ExecFileOptions = {
  cwd?: string;
  shell: false;
};

type ExecFileResult = {
  stdout: string;
  stderr: string;
};

export type GitClient = {
  run(args: string[], options?: { cwd?: string }): Promise<string>;
};

export type GitClientOptions = {
  execFile?: (
    file: string,
    args: string[],
    options: ExecFileOptions,
  ) => Promise<ExecFileResult>;
};

const execFile = promisify(nodeExecFile);
const SCP_LIKE_SSH = /^[^\s@/:]+@[^\s:/]+:[^\s]+$/;

function gitOriginForms(value: string): string[] {
  if (SCP_LIKE_SSH.test(value)) {
    const [userAndHost] = value.split(":", 1);
    const [, host] = userAndHost!.split("@", 2);
    return [
      `ssh://${userAndHost}`.toLowerCase(),
      userAndHost!.toLowerCase(),
      host!.toLowerCase(),
    ];
  }
  try {
    const url = new URL(value);
    const host = url.host.toLowerCase();
    const authority = `${url.protocol}//${url.username ? `${url.username}@` : ""}${host}`;
    return [authority.toLowerCase(), host];
  } catch {
    return [];
  }
}

/** The production installer never accepts local paths or arbitrary protocols. */
export function isProductionGitUrl(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) return false;
  if (SCP_LIKE_SSH.test(value)) return true;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "ssh:") ||
      url.hostname.length === 0
    ) {
      return false;
    }
    return (
      url.protocol === "ssh:" || (url.username === "" && url.password === "")
    );
  } catch {
    return false;
  }
}

/**
 * An empty allowlist trusts the production-URL gate alone: any HTTPS/SSH
 * origin may sync, and post-clone manifest validation owns the rest. A
 * non-empty allowlist is the operator's stricter mode — remote activation
 * then requires an exact hostname or Git authority match.
 */
export function isAllowedGitOrigin(
  value: string,
  allowedOrigins: readonly string[],
): boolean {
  if (!isProductionGitUrl(value)) return false;
  if (allowedOrigins.length === 0) return true;
  const allowed = new Set(
    allowedOrigins.map((origin) => origin.trim().toLowerCase()),
  );
  return gitOriginForms(value).some((form) => allowed.has(form));
}

/**
 * Git's invocation boundary. All callers supply a fixed argument vector; no
 * Hub value is interpolated into a shell command.
 */
export function createGitClient(options: GitClientOptions = {}): GitClient {
  const execute =
    options.execFile ??
    (async (file: string, args: string[], execOptions: ExecFileOptions) => {
      const result = await execFile(file, args, {
        cwd: execOptions.cwd,
        shell: execOptions.shell,
        encoding: "utf8",
      });
      return {
        stdout: String(result.stdout),
        stderr: String(result.stderr),
      };
    });

  return {
    async run(args, runOptions = {}) {
      const result = await execute("git", [...args], {
        cwd: runOptions.cwd,
        shell: false,
      });
      return result.stdout.trim();
    },
  };
}
