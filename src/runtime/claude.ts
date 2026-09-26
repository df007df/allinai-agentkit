import { probeCli, type WhichFn } from "./cli-probe.js";
import {
  mapClaudeCliEvent,
  spawnClaudeCli,
} from "./claude-cli.js";
import { drainToString, readJsonl } from "./codex-cli.js";
import type { PlatformEvent, PlatformProbe } from "./types.js";

export type ClaudeAdapterRunInput = {
  prompt: string;
  /** Domain/host prepares provider and plugin settings before crossing this boundary. */
  options?: Record<string, unknown>;
  /** Platform-level session id from a previous run; maps onto --resume. */
  sessionId?: string;
  model?: string;
  pluginDirs?: string[];
};

export type ClaudeAdapter = {
  readonly id: "claude";
  probe(): Promise<PlatformProbe>;
  start(
    input: ClaudeAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreateClaudeAdapterDeps = {
  /** Test seam for the CLI existence probe. */
  which?: WhichFn;
  /** Claude CLI command; defaults to "claude". Tests inject a stub script. */
  claudeCommand?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claude Code CLI adapter: spawns `claude -p --output-format stream-json`
 * in full-permission mode and maps its JSONL events. The CLI is the
 * distribution ground truth — it is exactly what probe reports as
 * installed, so execution cannot drift from it. Tool ask-user gating rides
 * the plugin-delivered PreToolUse hook, not an in-process callback.
 */
export function createClaudeAdapter(
  deps: CreateClaudeAdapterDeps = {},
): ClaudeAdapter {
  return {
    id: "claude",
    async probe(): Promise<PlatformProbe> {
      // CLI-first: installed means the claude binary exists on PATH.
      return await probeCli("claude", "claude", deps.which);
    },
    async *start(
      input: ClaudeAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: { aborted: true } };
        return;
      }

      const options = input.options ?? {};
      const sessionId =
        (typeof (options as Record<string, unknown>).resume === "string"
          ? ((options as Record<string, unknown>).resume as string)
          : undefined) ?? input.sessionId;
      const cwd = typeof (options as Record<string, unknown>).cwd === "string"
        ? ((options as Record<string, unknown>).cwd as string)
        : undefined;
      const model = typeof (options as Record<string, unknown>).model === "string"
        ? ((options as Record<string, unknown>).model as string)
        : input.model;

      const claudeCommand = deps.claudeCommand ?? "claude";
      const child = spawnClaudeCli(
        claudeCommand,
        {
          cwd,
          resumeSessionId: sessionId,
          prompt: input.prompt,
          model,
          maxTurns: 1,
          pluginDirs: Array.isArray(input.pluginDirs)
            ? input.pluginDirs.filter(
                (dir): dir is string => typeof dir === "string",
              )
            : [],
        },
        signal,
      );

      let sawDone = false;
      try {
        for await (const cliEvent of readJsonl(child.stdout)) {
          const mapped = mapClaudeCliEvent(cliEvent);
          if (!mapped) continue;
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") {
            sawDone = true;
            return;
          }
        }
        const exit = await child.onExit;
        if (!sawDone) {
          if (signal.aborted) {
            yield { type: "done", payload: { aborted: true } };
          } else if (exit.code !== 0) {
            const stderrText = await drainToString(child.stderr);
            yield {
              type: "error",
              payload: {
                message:
                  stderrText.trim() ||
                  `claude -p exited with code ${exit.code ?? "null"}`,
                cause: "cli_exit_nonzero",
              },
            };
          } else {
            yield { type: "done" };
          }
        }
      } catch (error) {
        if (signal.aborted) {
          yield { type: "done", payload: { aborted: true } };
          return;
        }
        yield {
          type: "error",
          payload: { message: errorMessage(error), cause: "cli_spawn_failed" },
        };
      }
    },
  };
}
