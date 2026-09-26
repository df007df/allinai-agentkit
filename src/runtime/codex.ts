import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";
import { probeCli, type WhichFn } from "./cli-probe.js";
import {
  drainToString,
  mapCodexCliEvent,
  readJsonl,
  spawnCodexCli,
} from "./codex-cli.js";

/**
 * Raised only when a caller asks to use an adapter whose optional SDK is absent.
 * Kept here for the historical import graph (claude/pi re-export it); new code
 * should not add SDK surfaces — every platform executes through its CLI.
 */
export class OptionalRuntimeDependencyError extends Error {
  readonly packageName: string;
  readonly installCommand: string;

  constructor(packageName: string, cause: unknown) {
    const installCommand = `npm install ${packageName}`;
    super(
      `The optional runtime dependency ${packageName} is not available. Install it with \`${installCommand}\`.`,
      { cause },
    );
    this.name = "OptionalRuntimeDependencyError";
    this.packageName = packageName;
    this.installCommand = installCommand;
  }
}

export type CodexAdapterRunInput = PlatformRunInput & {
  platform: "codex";
  /**
   * A previously reported Codex thread id, when this is a resume. Falls back
   * to the transport-level `sessionId` when the host does not set this alias.
   */
  resumeThreadId?: string;
};

export type CodexAdapter = {
  readonly id: "codex";
  probe(): Promise<PlatformProbe>;
  start(
    input: CodexAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreateCodexAdapterDeps = {
  /** Test seam for the CLI existence probe. */
  which?: WhichFn;
  /** Codex CLI command; defaults to "codex". Tests inject a stub script. */
  codexCommand?: string;
};

function payload(values: Record<string, unknown>): PlatformEvent["payload"] {
  return values;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Codex CLI adapter: spawns `codex exec --json` with full access and maps
 * its JSONL events. The CLI is the distribution ground truth — it is
 * exactly what probe reports as installed, so execution cannot drift from
 * it. Tool ask-user gating rides the plugin-delivered PreToolUse hook.
 */
export function createCodexAdapter(
  deps: CreateCodexAdapterDeps = {},
): CodexAdapter {
  return {
    id: "codex",
    async probe(): Promise<PlatformProbe> {
      // CLI-first: installed means the codex binary exists on PATH. This
      // makes no claim about login state.
      return await probeCli("codex", "codex", deps.which);
    },
    async *start(
      input: CodexAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: payload({ aborted: true }) };
        return;
      }

      const resumeThreadId = input.resumeThreadId ?? input.sessionId;
      if (resumeThreadId) {
        yield {
          type: "init",
          payload: payload({
            runtimeSessionId: resumeThreadId,
            resumed: true,
          }),
        };
      }

      const codexCommand = deps.codexCommand ?? "codex";
      const child = spawnCodexCli(
        codexCommand,
        {
          args: [],
          cwd: input.cwd,
          resumeThreadId,
          prompt: input.prompt,
        },
        signal,
      );

      let terminal = false;
      let sawInit = resumeThreadId !== undefined;
      try {
        for await (const cliEvent of readJsonl(child.stdout)) {
          const mapped = mapCodexCliEvent(cliEvent, resumeThreadId);
          if (!mapped) continue;
          if (mapped.type === "init") {
            // A resumed run re-emits thread.started; keep the resume init.
            if (sawInit) continue;
            sawInit = true;
          }
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") {
            terminal = true;
            return;
          }
        }
        const exit = await child.onExit;
        if (!terminal) {
          if (signal.aborted) {
            yield { type: "done", payload: payload({ aborted: true }) };
          } else if (exit.code !== 0) {
            const stderrText = await drainToString(child.stderr);
            yield {
              type: "error",
              payload: payload({
                message:
                  stderrText.trim() ||
                  `codex exec exited with code ${exit.code ?? "null"}`,
                cause: "cli_exit_nonzero",
              }),
            };
          } else {
            yield { type: "done", payload: undefined };
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield { type: "done", payload: payload({ aborted: true }) };
          return;
        }
        yield {
          type: "error",
          payload: payload({
            message: errorMessage(error),
            cause: "cli_spawn_failed",
          }),
        };
      }
    },
  };
}
