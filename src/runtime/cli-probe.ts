import { execFile } from "node:child_process";
import type { PlatformProbe } from "./types.js";

export type WhichFn = (name: string) => Promise<string | null>;

/** Default PATH lookup; injectable in tests. */
export function defaultWhich(name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [name], { shell: false }, (error, stdout) => {
      if (error) resolve(null);
      else resolve(String(stdout).trim() || null);
    });
  });
}

/**
 * CLI-first probe: a platform counts as installed when its command-line
 * binary exists on PATH. This is the distribution-ground-truth signal —
 * SDK importability says nothing about the machine and is no longer probed.
 */
export async function probeCli(
  id: string,
  command: string,
  which: WhichFn = defaultWhich,
): Promise<PlatformProbe> {
  const cliPath = await which(command);
  if (!cliPath) {
    return {
      installed: false,
      version: null,
      reason: `${command} CLI not found on PATH`,
    };
  }
  return { installed: true, version: null, reason: cliPath };
}
