import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export type AgentLogEntry = Record<string, unknown>;

export type LoggerFileSystem = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  stat(file: string): Promise<{ size: number }>;
  appendFile(file: string, content: string, encoding: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
};

export type RotatingJsonlLogger = {
  write(entry: AgentLogEntry): Promise<void>;
};

export type RotatingJsonlLoggerOptions = {
  logsRoot: string;
  maxBytes?: number;
  maxFiles?: number;
  fileSystem?: LoggerFileSystem;
  now?: () => Date;
};

const redactKey =
  /(?:token|secret|password|authorization|credential|api[-_]?key)$/i;
const bearerValue = /\b(?:bearer|basic)\s+[^\s,;]+/gi;
const inlineSecret =
  /\b((?:(?:access|refresh|id)[_-]?token|(?:client)?[_-]?secret|api[-_]?key|token|password|authorization|credential))\s*([:=])\s*[^\s,;]+/gi;

function redactString(value: string): string {
  return value
    .replace(bearerValue, (match) => `${match.split(/\s+/, 1)[0]} [REDACTED]`)
    .replace(
      inlineSecret,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    );
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = redactKey.test(key)
      ? "[REDACTED]"
      : redactValue(nested, seen);
  }
  return result;
}

/** Serialize one JSONL record after removing credential-shaped values. */
export function serializeLog(entry: AgentLogEntry): string {
  const redacted = redactValue(entry);
  try {
    return `${JSON.stringify(redacted)}\n`;
  } catch {
    return `${JSON.stringify({ message: "[Unserializable log entry]" })}\n`;
  }
}

const loggerFs: LoggerFileSystem = { mkdir, stat, appendFile, rename, unlink };

function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function sizeOf(fs: LoggerFileSystem, file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch (error) {
    if (absent(error)) return 0;
    throw error;
  }
}

async function removeIfPresent(
  fs: LoggerFileSystem,
  file: string,
): Promise<void> {
  try {
    await fs.unlink(file);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

/** JSONL file logger with bounded rotation and no unredacted writes. */
export function createRotatingJsonlLogger(
  options: RotatingJsonlLoggerOptions,
): RotatingJsonlLogger {
  const fs = options.fileSystem ?? loggerFs;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive integer");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new RangeError("maxFiles must be a positive integer");
  }
  const file = path.join(options.logsRoot, "agent.log");
  let writing = Promise.resolve();

  async function rotate(): Promise<void> {
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const current = `${file}.${index}`;
      const next = `${file}.${index + 1}`;
      await removeIfPresent(fs, next);
      try {
        await fs.rename(current, next);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    try {
      await fs.rename(file, `${file}.1`);
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }

  return {
    write(entry) {
      const timestamp =
        options.now?.().toISOString() ?? new Date().toISOString();
      const line = serializeLog({ timestamp, ...entry });
      writing = writing.then(async () => {
        await fs.mkdir(options.logsRoot, { recursive: true });
        if (
          (await sizeOf(fs, file)) > 0 &&
          (await sizeOf(fs, file)) + Buffer.byteLength(line) > maxBytes
        ) {
          await rotate();
        }
        await fs.appendFile(file, line, "utf8");
      });
      return writing;
    },
  };
}

/**
 * Bridge logging port. Default implementation writes to console (debug
 * suppressed unless ALLINAI_BRIDGE_DEBUG=1); hosts replace it via
 * setBridgeLogger (e.g. AllInAI wires electron-log).
 */
export type BridgeLogLevel = "debug" | "info" | "warn";

export type BridgeLogger = {
  debug(tag: string, message: string, meta?: Record<string, unknown>): void;
  info(tag: string, message: string, meta?: Record<string, unknown>): void;
  warn(tag: string, message: string, meta?: Record<string, unknown>): void;
};

function format(
  tag: string,
  message: string,
  meta?: Record<string, unknown>,
): string {
  let suffix = "";
  if (meta && Object.keys(meta).length > 0) {
    try {
      suffix = ` ${JSON.stringify(meta)}`;
    } catch {
      suffix = ` ${String(meta)}`;
    }
  }
  return `[bridge:${tag}] ${message}${suffix}`;
}

export function createConsoleLogger(options?: {
  debug?: boolean;
}): BridgeLogger {
  const showDebug =
    options?.debug ??
    (typeof process !== "undefined" &&
      process.env?.ALLINAI_BRIDGE_DEBUG === "1");
  return {
    debug(tag, message, meta) {
      if (showDebug) console.log(format(tag, message, meta));
    },
    info(tag, message, meta) {
      console.log(format(tag, message, meta));
    },
    warn(tag, message, meta) {
      console.error(format(tag, message, meta));
    },
  };
}

let current: BridgeLogger | null = null;
let defaultLogger: BridgeLogger | null = null;

/** Replace the process-wide bridge logger (call before creating hub/bridge). */
export function setBridgeLogger(logger: BridgeLogger): void {
  current = logger;
}

/** Test hook: fall back to the default console logger. */
export function resetBridgeLogger(): void {
  current = null;
}

/** Internal facade used by SDK modules. */
export const bridgeLog: BridgeLogger = {
  debug(tag, message, meta) {
    if (!current) {
      defaultLogger ??= createConsoleLogger();
    }
    (current ?? defaultLogger)!.debug(tag, message, meta);
  },
  info(tag, message, meta) {
    if (!current) {
      defaultLogger ??= createConsoleLogger();
    }
    (current ?? defaultLogger)!.info(tag, message, meta);
  },
  warn(tag, message, meta) {
    if (!current) {
      defaultLogger ??= createConsoleLogger();
    }
    (current ?? defaultLogger)!.warn(tag, message, meta);
  },
};
