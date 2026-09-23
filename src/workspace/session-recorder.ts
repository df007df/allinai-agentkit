import { mkdir, appendFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { ClientEvent } from "../protocol/index.js";
import type { PlatformEvent, PlatformRunInput, RunnerManager } from "../runtime/types.js";
import { bridgeLog } from "../logger.js";

export type SessionRecordMeta = {
  executionId: string;
  sessionDir: string;
  project?: { name: string; dir: string };
  runtime?: string;
  cwd?: string;
  prompt?: string;
};

export type SessionRecorderFileSystem = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  appendFile(file: string, content: string, encoding: "utf8"): Promise<void>;
  writeFile(file: string, content: string, options: { encoding: "utf8"; flag?: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(file: string): Promise<{ size: number }>;
  unlink(file: string): Promise<void>;
};

function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

const fs: SessionRecorderFileSystem = {
  mkdir,
  appendFile,
  writeFile,
  rename,
  stat: async () => ({ size: 0 }),
  unlink: async () => undefined,
};

const TERMINAL_EVENT_TYPES = new Set([
  "done",
  "failed",
  "cancelled",
  "rejected",
  "recovery_required",
]);

/**
 * Mirrors the durable client-event stream into
 * projects/<project>/sessions/<executionId>/ on disk: one events.jsonl plus a
 * session.json summary that gains its terminal fields when the run ends.
 * Runs are tracked through a thin RunnerManager wrapper — the supervisor
 * already computes each run's sessionDir on PlatformRunInput — so the
 * recorder never needs its own view of project state. Recording is
 * best-effort: a failed write never blocks execution delivery.
 */
export class SessionRecorder {
  private readonly meta = new Map<string, SessionRecordMeta>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly fileSystem: SessionRecorderFileSystem = fs) {}

  /** Wraps a runner so every started run's events mirror to its session dir. */
  wrapRunner(runner: RunnerManager): RunnerManager {
    const recorder = this;
    return {
      start(executionId: string, input: PlatformRunInput) {
        const events = runner.start(executionId, input);
        if (!input.sessionDir) return events;
        recorder.track({
          executionId,
          sessionDir: input.sessionDir,
          runtime: input.platform,
          cwd: input.cwd,
          prompt: input.prompt,
          project:
            input.context &&
            typeof input.context.project === "string" &&
            typeof input.context.projectRecordDir === "string"
              ? {
                  name: input.context.project,
                  dir: input.context.projectRecordDir,
                }
              : undefined,
        });
        return recorder.tee(executionId, events);
      },
      cancel: (executionId) => runner.cancel(executionId),
      respondToolApproval:
        runner.respondToolApproval?.bind(runner) ?? undefined,
      ownerOfToolApproval:
        runner.ownerOfToolApproval?.bind(runner) ?? undefined,
      waitForIdle: runner.waitForIdle?.bind(runner) ?? undefined,
    } as RunnerManager;
  }

  /** Resolves when all pending writes for one execution are on disk. */
  async drain(executionId?: string): Promise<void> {
    const pending = [...this.writes.entries()].filter(
      ([id]) => executionId === undefined || id === executionId,
    );
    await Promise.all(pending.map(([, write]) => write));
  }

  /**
   * Passes every runner event through untouched while mirroring a normalized
   * record into events.jsonl. Deltas and vendor frames are skipped: the
   * session record is a state timeline, not a transcript.
   */
  private tee(
    executionId: string,
    events: AsyncIterable<PlatformEvent>,
  ): AsyncIterable<PlatformEvent> {
    const recorder = this;
    async function* filtered(): AsyncGenerator<PlatformEvent> {
      for await (const event of events) {
        if (
          event.type !== "text_delta" &&
          event.type !== "thinking_delta" &&
          event.type !== "vendor"
        ) {
          recorder.record({
            executionId,
            eventSeq: 0,
            type:
              event.type === "error"
                ? "failed"
                : event.type === "done"
                  ? "done"
                  : "progress",
            occurredAt: new Date().toISOString(),
            payload: event.payload,
          });
        }
        yield event;
      }
    }
    return filtered();
  }

  private track(meta: SessionRecordMeta): void {
    this.meta.set(meta.executionId, meta);
  }

  private record(event: ClientEvent): void {
    const meta = this.meta.get(event.executionId);
    if (!meta) return;
    const previous = this.writes.get(event.executionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.writeEvent(meta, event));
    this.writes.set(event.executionId, write);
  }

  private async writeEvent(
    meta: SessionRecordMeta,
    event: ClientEvent,
  ): Promise<void> {
    try {
      await this.fileSystem.mkdir(meta.sessionDir, { recursive: true });
      await this.fileSystem.appendFile(
        path.join(meta.sessionDir, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        await this.writeSessionSummary(meta, event);
      }
    } catch (error) {
      bridgeLog.warn("execution", "session_record_failed", {
        executionId: meta.executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async writeSessionSummary(
    meta: SessionRecordMeta,
    terminal: ClientEvent,
  ): Promise<void> {
    const summary = {
      executionId: meta.executionId,
      runtime: meta.runtime,
      project: meta.project?.name,
      cwd: meta.cwd,
      prompt: meta.prompt,
      state: terminal.type,
      endedAt: terminal.occurredAt,
      lastError:
        terminal.type === "failed"
          ? ((terminal.payload?.message as string | undefined) ??
            terminal.payload?.reason)
          : undefined,
    };
    const file = path.join(meta.sessionDir, "session.json");
    const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
    await this.fileSystem.writeFile(
      temporary,
      `${JSON.stringify(summary, null, 2)}\n`,
      { encoding: "utf8" },
    );
    await this.fileSystem.rename(temporary, file);
  }
}
