import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { AgentPaths } from "../paths.js";
import type { PlatformId } from "../runtime/types.js";

/** The built-in default project. Its cwd is a disposable per-run directory. */
export const DEFAULT_PROJECT_NAME = "default";

/**
 * One prepared execution workspace: the directory the runner child uses as
 * cwd, plus where the session recorder mirrors events for it. The session
 * directory always lives under the agent home's projects tree so a bound
 * project's own directory is never polluted with run records.
 */
export type ExecutionWorkspace = {
  /** Absolute cwd passed to the platform adapter. */
  cwd: string;
  /** Absolute projects/<...>/sessions/<executionId> directory. */
  sessionDir: string;
};export type WorkspaceLayout = {
  projectsRoot: string;
  defaultProjectDir: string;
  defaultRuntimeDir: string;
};

/**
 * Registered project record roots follow `projects/<name>-<suffix>`; the
 * suffix is generated at `project add` time and persisted in config.json.
 * `default` is the reserved built-in project.
 */
export function workspaceLayout(paths: AgentPaths): WorkspaceLayout {
  const projectsRoot = path.join(paths.home, "projects");
  return {
    projectsRoot,
    defaultProjectDir: path.join(projectsRoot, DEFAULT_PROJECT_NAME),
    defaultRuntimeDir: path.join(
      projectsRoot,
      DEFAULT_PROJECT_NAME,
      "runtime",
    ),
  };
}

/** Record root for a registered project: projects/<name>-<suffix>. */
export function projectRecordDir(
  paths: AgentPaths,
  project: { name: string; dir: string },
): string {
  return path.join(workspaceLayout(paths).projectsRoot, `${project.name}-${project.dir}`);
}

/** Directory suffix appended at `project add` time; stable across restarts. */
export function projectDirectorySuffix(): string {
  return randomBytes(3).toString("hex");
}

export type WorkspaceFileSystem = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
};

/**
 * Prepares the cwd for one execution before the runner child spawns, plus the
 * session-record directory for that execution:
 * - A Hub-selected registered project runs directly in its configured path and
 *   records under projects/<name>-<dir>/sessions/<executionId>.
 * - Any other run (absent or unknown project) gets a fresh
 *   projects/default/runtime/<platform>/<executionId> scratch cwd and records
 *   under projects/default/sessions/<executionId>, so a daemon started by
 *   launchd/systemd never litters its service cwd and default runs remain
 *   inspectable and cleanable per execution.
 */
export async function prepareExecutionWorkspace(input: {
  paths: AgentPaths;
  platform: PlatformId;
  executionId: string;
  /** Bound run: the configured project directory (cwd) and its record suffix. */
  project?: { path: string; dir: string; name: string };
  fs?: WorkspaceFileSystem;
}): Promise<ExecutionWorkspace> {
  const fs = input.fs ?? { mkdir };
  if (input.project) {
    await fs.mkdir(input.project.path, { recursive: true });
    return {
      cwd: input.project.path,
      sessionDir: sessionDirectoryFor(input.paths, {
        executionId: input.executionId,
        project: input.project,
      }),
    };
  }
  const layout = workspaceLayout(input.paths);
  const cwd = path.join(
    layout.defaultRuntimeDir,
    input.platform,
    input.executionId,
  );
  await fs.mkdir(cwd, { recursive: true });
  return {
    cwd,
    sessionDir: sessionDirectoryFor(input.paths, {
      executionId: input.executionId,
    }),
  };
}

/**
 * The session record directory for one execution:
 * - default runs: projects/default/sessions/<executionId>
 * - registered runs: projects/<name>-<suffix>/sessions/<executionId>
 */
export function sessionDirectoryFor(
  paths: AgentPaths,
  input: {
    executionId: string;
    project?: { name: string; dir: string };
  },
): string {
  const layout = workspaceLayout(paths);
  if (!input.project) {
    return path.join(layout.defaultProjectDir, "sessions", input.executionId);
  }
  return path.join(
    projectRecordDir(paths, input.project),
    "sessions",
    input.executionId,
  );
}
