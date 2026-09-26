import { probeCli, type WhichFn } from "./cli-probe.js";
import { mapPiCliEvent } from "./pi-cli.js";
import { readJsonl } from "./codex-cli.js";
import { spawn } from "node:child_process";
import type {
  PlatformEvent,
  PlatformProbe,
  PlatformRunInput,
} from "./types.js";

export type PiAdapterRunInput = PlatformRunInput & {
  platform: "pi";
};

export type PiAdapter = {
  readonly id: "pi";
  probe(): Promise<PlatformProbe>;
  start(
    input: PiAdapterRunInput,
    signal: AbortSignal,
  ): AsyncIterable<PlatformEvent>;
};

export type CreatePiAdapterDeps = {
  /** Test seam for the CLI existence probe. */
  which?: WhichFn;
  /** Pi CLI command; defaults to "pi". Tests inject a stub script. */
  piCommand?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pi CLI adapter: spawns `pi -p --mode json` with optional `--session`
 * resume and maps its JSONL events. The CLI is the distribution ground
 * truth — it is exactly what probe reports as installed, so execution
 * cannot drift from it. Tool ask-user gating rides the plugin-delivered
 * extension (.pi/extensions in managed projects), not an in-process bridge.
 */
export function createPiAdapter(
  deps: CreatePiAdapterDeps = {},
): PiAdapter {
  return {
    id: "pi",
    async probe(): Promise<PlatformProbe> {
      // CLI-first: installed means the pi binary exists on PATH.
      return await probeCli("pi", "pi", deps.which);
    },
    async *start(
      input: PiAdapterRunInput,
      signal: AbortSignal,
    ): AsyncIterable<PlatformEvent> {
      if (signal.aborted) {
        yield { type: "done", payload: { aborted: true } };
        return;
      }

      if (input.sessionId) {
        yield {
          type: "init",
          payload: { runtimeSessionId: input.sessionId, resumed: true },
        };
      }
      const args: string[] = ["-p", "--mode", "json"];
      if (input.model) args.push("--model", input.model);
      if (input.cwd) args.push("--cwd", input.cwd);
      if (input.sessionId) args.push("--session", input.sessionId);
      args.push(input.prompt);

      const child = spawn(deps.piCommand ?? "pi", args, {
        cwd: input.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      // Abort is an expected path (signal passed to spawn): abort() emits
      // 'error' on the child immediately, so the listener must attach before
      // anything can await — a late listener turns it into an uncaught event.
      const exit = new Promise<{ code: number | null }>((resolve) => {
        child.once("error", () => resolve({ code: null }));
        child.once("close", (code) => resolve({ code }));
      });
      const stdout = readJsonl(
        child.stdout as unknown as AsyncIterable<string>,
      );
      const stderrChunks: string[] = [];
      const stderrDone = (async () => {
        try {
          child.stderr?.setEncoding("utf8");
          for await (const chunk of child.stderr) {
            stderrChunks.push(String(chunk));
          }
        } catch {
          // Abort (or early close) destroys the stream mid-read; stderr is
          // best-effort diagnostics and must never reject unobserved.
        }
      })();
      let sawDone = false;
      try {
        for await (const cliEvent of stdout) {
          const mapped = mapPiCliEvent(cliEvent);
          if (!mapped) continue;
          if (mapped.type === "init" && input.sessionId) continue;
          yield mapped;
          if (mapped.type === "done" || mapped.type === "error") {
            sawDone = true;
            return;
          }
        }
        const exitCode = await exit;
        // Keep the stderr collector observed so its failure can never surface
        // as an unhandled rejection after the run has settled.
        await stderrDone.catch(() => undefined);
        if (!sawDone) {
          if (signal.aborted) {
            yield { type: "done", payload: { aborted: true } };
          } else if (exitCode.code !== 0) {
            yield {
              type: "error",
              payload: {
                message: stderrChunks.join("").trim() || `pi exited with code ${exitCode.code ?? "null"}`,
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
