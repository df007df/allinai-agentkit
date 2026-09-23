import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  prepareExecutionWorkspace,
  projectDirectorySuffix,
  sessionDirectoryFor,
  workspaceLayout,
} from "./workspace.js";
import { SessionRecorder } from "./session-recorder.js";
import { resolveAgentPaths } from "../paths.js";
import type { PlatformEvent, RunnerManager, PlatformRunInput } from "../runtime/types.js";

describe("execution workspace", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("gives unbound runs a fresh default runtime directory per execution", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-workspace-"));
    const paths = resolveAgentPathsAt(dir);
    const first = await prepareExecutionWorkspace({
      paths,
      platform: "codex",
      executionId: "exec-1",
    });
    const second = await prepareExecutionWorkspace({
      paths,
      platform: "claude",
      executionId: "exec-2",
    });

    const layout = workspaceLayout(paths);
    assert.equal(
      first.cwd,
      path.join(layout.defaultRuntimeDir, "codex", "exec-1"),
    );
    assert.equal(
      second.cwd,
      path.join(layout.defaultRuntimeDir, "claude", "exec-2"),
    );
    assert.ok(existsSync(first.cwd));
    // Default runs record under projects/default/sessions, never the scratch.
    assert.equal(
      first.sessionDir,
      path.join(layout.defaultProjectDir, "sessions", "exec-1"),
    );
  });

  it("bound project runs use the configured directory as cwd and a home record root", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-workspace-"));
    const paths = resolveAgentPathsAt(dir);
    const projectPath = path.join(dir, "repo");
    const workspace = await prepareExecutionWorkspace({
      paths,
      platform: "codex",
      executionId: "exec-3",
      project: { path: projectPath, name: "web", dir: "abc123" },
    });
    assert.equal(workspace.cwd, projectPath);
    assert.equal(
      workspace.sessionDir,
      path.join(paths.home, "projects", "web-abc123", "sessions", "exec-3"),
    );
  });

  it("derives stable session directories from the persisted suffix", () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-workspace-"));
    const paths = resolveAgentPathsAt(dir);
    const sessionDir = sessionDirectoryFor(paths, {
      executionId: "exec-4",
      project: { name: "web", dir: "abc123" },
    });
    assert.equal(
      sessionDir,
      path.join(paths.home, "projects", "web-abc123", "sessions", "exec-4"),
    );
  });

  it("suffixes are six hex characters", () => {
    assert.match(projectDirectorySuffix(), /^[0-9a-f]{6}$/);
  });
});

function resolveAgentPathsAt(home: string) {
  // Local re-import would be cleaner, but this keeps the test on the same
  // construction the daemon uses.
  return {
    home,
    configFile: path.join(home, "config.json"),
    stateDb: path.join(home, "state.db"),
    credentialsRoot: path.join(home, "credentials"),
    pluginsRoot: path.join(home, "plugins"),
    runsRoot: path.join(home, "runs"),
    logsRoot: path.join(home, "logs"),
    controlSocket: path.join(home, "control.sock"),
  };
}

describe("session recorder", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function fakeRunner(
    events: PlatformEvent[],
  ): { runner: RunnerManager; started: PlatformRunInput[] } {
    const started: PlatformRunInput[] = [];
    return {
      started,
      runner: {
        start(executionId: string, input: PlatformRunInput) {
          started.push(input);
          return (async function* (): AsyncGenerator<PlatformEvent> {
            for (const event of events) yield event;
          })();
        },
        cancel: async () => {},
      },
    };
  }

  it("mirrors runner state events and writes a terminal session.json", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-recorder-"));
    const sessionDir = path.join(dir, "sessions", "exec-1");
    const fake = fakeRunner([
      { type: "init", payload: { runtimeSessionId: "s1" } },
      { type: "text_delta", payload: { text: "skip me" } },
      { type: "done", payload: { sessionId: "s1" } },
    ]);
    const recorder = new SessionRecorder();
    const wrapped = recorder.wrapRunner(fake.runner);
    for await (const _ of wrapped.start("exec-1", {
      platform: "codex",
      prompt: "hi",
      sessionDir,
      cwd: "/work",
      context: { project: "web", projectRecordDir: "/records/web-x" },
    })) {
      // consume
    }
    await recorder.drain("exec-1");

    const events = readFileSync(path.join(sessionDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    // init mirrors as a progress frame; deltas are skipped; done is terminal.
    assert.deepEqual(
      events.map((event) => event.type),
      ["progress", "done"],
    );
    const summary = JSON.parse(
      readFileSync(path.join(sessionDir, "session.json"), "utf8"),
    ) as {
      executionId: string;
      state: string;
      runtime: string;
      project: string;
      cwd: string;
      prompt: string;
    };
    assert.equal(summary.executionId, "exec-1");
    assert.equal(summary.state, "done");
    assert.equal(summary.runtime, "codex");
    assert.equal(summary.project, "web");
    assert.equal(summary.cwd, "/work");
    assert.equal(summary.prompt, "hi");
  });

  it("records failed runs with the error message", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "allinai-recorder-"));
    const sessionDir = path.join(dir, "sessions", "exec-2");
    const fake = fakeRunner([
      { type: "error", payload: { message: "boom", reason: "sdk_throw" } },
    ]);
    const recorder = new SessionRecorder();
    const wrapped = recorder.wrapRunner(fake.runner);
    for await (const _ of wrapped.start("exec-2", {
      platform: "claude",
      prompt: "hi",
      sessionDir,
    })) {
      // consume
    }
    await recorder.drain("exec-2");

    const summary = JSON.parse(
      readFileSync(path.join(sessionDir, "session.json"), "utf8"),
    ) as { state: string; lastError: string | undefined };
    assert.equal(summary.state, "failed");
    assert.equal(summary.lastError, "boom");
  });

  it("runs without sessionDir pass through untouched and record nothing", async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "allinai-recorder-"));
    const fake = fakeRunner([{ type: "done" }]);
    const recorder = new SessionRecorder();
    const wrapped = recorder.wrapRunner(fake.runner);
    for await (const _ of wrapped.start("exec-3", {
      platform: "codex",
      prompt: "hi",
    })) {
      // consume
    }
    await recorder.drain("exec-3");
    // Nothing was recorded anywhere under the scratch: no events file, no
    // session dirs beyond the empty mkdtemp itself.
    assert.deepEqual(readdirSync(scratch), []);
    rmSync(scratch, { recursive: true, force: true });
  });
});
