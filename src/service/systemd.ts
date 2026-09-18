import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  UserServiceDefinition,
  UserServiceExecutor,
  UserServiceFileSystem,
} from "./launchd.js";

export const SYSTEMD_USER_UNIT_NAME = "allinai-agent.service";

export type SystemdUserActionOptions = UserServiceDefinition & {
  homeDir: string;
  uid: number;
  fileSystem?: UserServiceFileSystem;
  execute?: UserServiceExecutor;
};

const serviceFs: UserServiceFileSystem = { mkdir, writeFile, unlink };

function isSafeAbsolutePath(value: string): boolean {
  return (
    path.isAbsolute(value) &&
    value.length > 1 &&
    !value.includes("\0") &&
    !/[\r\n]/.test(value)
  );
}

function assertDefinition(input: UserServiceDefinition): void {
  if (!isSafeAbsolutePath(input.executable)) {
    throw new TypeError("Service executable must be an absolute path");
  }
  if (!isSafeAbsolutePath(input.configDir)) {
    throw new TypeError("Service configDir must be an absolute path");
  }
}

function assertUserUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new Error("Agent service installation requires a non-root user");
  }
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

/** The only Linux unit path owned by a per-user Agent Client install. */
export function systemdUserUnitPath(homeDir: string): string {
  if (!isSafeAbsolutePath(homeDir)) {
    throw new TypeError("User homeDir must be an absolute path");
  }
  return path.join(
    homeDir,
    ".config",
    "systemd",
    "user",
    SYSTEMD_USER_UNIT_NAME,
  );
}

/** Deterministic systemd --user unit; it never names a system-wide unit. */
export function buildSystemdUserUnit(input: UserServiceDefinition): string {
  assertDefinition(input);
  return `[Unit]\nDescription=AllInAI Agent Client\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdEscape(input.executable)} daemon --config-dir ${systemdEscape(input.configDir)}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

export async function installSystemdUserService(
  options: SystemdUserActionOptions,
): Promise<string> {
  assertDefinition(options);
  assertUserUid(options.uid);
  const destination = systemdUserUnitPath(options.homeDir);
  const fs = options.fileSystem ?? serviceFs;
  const execute = options.execute ?? defaultSystemctl;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.mkdir(path.join(options.configDir, "logs"), { recursive: true });
  await fs.writeFile(destination, buildSystemdUserUnit(options), {
    encoding: "utf8",
    mode: 0o644,
  });
  await execute("systemctl", ["--user", "daemon-reload"]);
  await execute("systemctl", [
    "--user",
    "enable",
    "--now",
    SYSTEMD_USER_UNIT_NAME,
  ]);
  return destination;
}

export async function uninstallSystemdUserService(
  options: Omit<SystemdUserActionOptions, "executable" | "configDir">,
): Promise<string> {
  assertUserUid(options.uid);
  const destination = systemdUserUnitPath(options.homeDir);
  const fs = options.fileSystem ?? serviceFs;
  const execute = options.execute ?? defaultSystemctl;
  await execute("systemctl", [
    "--user",
    "disable",
    "--now",
    SYSTEMD_USER_UNIT_NAME,
  ]);
  await fs.unlink(destination);
  await execute("systemctl", ["--user", "daemon-reload"]);
  return destination;
}

export async function restartSystemdUserService(
  execute: UserServiceExecutor = defaultSystemctl,
): Promise<void> {
  await execute("systemctl", ["--user", "restart", SYSTEMD_USER_UNIT_NAME]);
}

async function defaultSystemctl(
  file: string,
  args: readonly string[],
): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(file, [...args], { shell: false }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
