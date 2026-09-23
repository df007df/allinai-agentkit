/**
 * The CLI usage manual as one typed data structure with two renderings:
 * `docs` prints Markdown for humans and LLM agents; `docs --json` prints the
 * structure itself for agents that parse strictly. Content is embedded in
 * code because the npm tarball ships only `bin/` and `dist/`.
 *
 * Keep this in lockstep with COMMAND_OPTIONS in commands.ts — docs.test.ts
 * fails if a command is accepted but undocumented, or documented but
 * rejected, or if an option flag is missing from the manual.
 */

export type ManualOption = {
  /** Flag exactly as typed, e.g. "hub" or "f" (short options excluded from validation). */
  flag: string;
  description: string;
  required?: boolean;
};

export type ManualCommand = {
  name: string;
  summary: string;
  options: ManualOption[];
  example: string;
  /** True when the command blocks the foreground until interrupted. */
  longRunning?: boolean;
};

export type ManualRecipe = {
  title: string;
  description: string;
  steps: string[];
};

export type ManualConfigField = {
  field: string;
  description: string;
};

export type CliManual = {
  schema: "allinai-agentkit.cli-manual";
  package: string;
  overview: string;
  quickstart: string[];
  commands: ManualCommand[];
  configFields: ManualConfigField[];
  filesystem: { path: string; description: string }[];
  recipes: ManualRecipe[];
  agentNotes: string[];
};

export function cliManual(): CliManual {
  return {
    schema: "allinai-agentkit.cli-manual",
    package: "@allin-ai/agentkit",
    overview:
      "Standalone persistent Agent Client: connect to a Hub over WebSocket, " +
      "durably execute local platform agents (codex / claude / pi / zcode) " +
      "and policy-gated capabilities, and report state upstream. This manual " +
      "covers every allinai-agentkit subcommand so an agent can configure, " +
      "run and diagnose the client without reading the source.",
    quickstart: [
      "allinai-agentkit web    # terminal A: local Console (Hub + web UI) on http://127.0.0.1:4317; requires @allin-ai/agentkit-web",
      "allinai-agentkit login --hub http://127.0.0.1:4317   # terminal B: browser pairing; requires the Console running",
      "allinai-agentkit daemon  # terminal B: run the persistent client in the foreground",
      "# headless / CI: skip the browser and pair directly:",
      "allinai-agentkit init --hub http://127.0.0.1:4317 --token <TOKEN>",
      "allinai-agentkit doctor  # verify git, config, pairing and runtime detection",
    ],
    commands: [
      {
        name: "init",
        summary:
          "Create the local config and optionally store a pairing token. " +
          "Use this on headless servers or CI where no browser is available.",
        options: [
          { flag: "hub", description: "Hub base URL, e.g. http://127.0.0.1:4317", required: true },
          { flag: "client", description: "Client ID (defaults to a fresh UUID, persisted in config)" },
          { flag: "token", description: "Pairing token saved into the credential store" },
        ],
        example: "allinai-agentkit init --hub http://127.0.0.1:4317 --token $TOKEN",
      },
      {
        name: "login",
        summary:
          "Browser-based pairing: requests an authorize URL, waits for approval, saves the token.",
        options: [
          { flag: "hub", description: "Hub base URL", required: true },
          { flag: "client", description: "Client ID (defaults to existing config or a fresh UUID)" },
          { flag: "no-browser", description: "Print the authorize URL without opening a browser" },
        ],
        example: "allinai-agentkit login --hub http://127.0.0.1:4317 --no-browser",
      },
      {
        name: "web",
        summary:
          "Start the local Console: Hub + web UI in one process (requires @allin-ai/agentkit-web)",
        options: [
          { flag: "port", description: "Listen port (default 4317)" },
          { flag: "host", description: "Listen host" },
        ],
        example: "allinai-agentkit web --port 4317",
        longRunning: true,
      },
      {
        name: "daemon",
        summary:
          "Run the persistent client in the foreground: register with the Hub, " +
          "receive agent.run commands, execute local agents, report events.",
        options: [],
        example: "allinai-agentkit daemon",
        longRunning: true,
      },
      {
        name: "install",
        summary:
          "Register a user-level OS service (macOS launchd / Linux systemd) so the daemon starts at login.",
        options: [],
        example: "allinai-agentkit install",
      },
      {
        name: "codex-hooks",
        summary:
          "Install the Codex PreToolUse approval hook: tool calls post to the local daemon and its synchronous reply allows or blocks them. Codex has no SDK approval callback, so this out-of-process hook is the only gating channel. After installing, run `codex` and trust the hook via /hooks (untrusted hooks are skipped).",
        options: [
          {
            flag: "control-endpoint",
            description:
              "Daemon control endpoint base URL; default http://127.0.0.1:8787.",
          },
          {
            flag: "codex-home",
            description: "Codex home directory; default ~/.codex.",
          },
        ],
        example:
          "allinai-agentkit codex-hooks --control-endpoint http://127.0.0.1:8787",
      },
      {
        name: "uninstall",
        summary: "Remove the user-level OS service.",
        options: [],
        example: "allinai-agentkit uninstall",
      },
      {
        name: "restart",
        summary: "Restart the user-level OS service (applies config changes immediately).",
        options: [],
        example: "allinai-agentkit restart",
      },
      {
        name: "status",
        summary: "Query the running daemon over the local control socket. Prints JSON.",
        options: [],
        example: "allinai-agentkit status",
      },
      {
        name: "logs",
        summary: "Print the execution log (rotating JSONL, verbatim).",
        options: [{ flag: "f", description: "Follow new log lines" }],
        example: "allinai-agentkit logs -f",
      },
      {
        name: "sync",
        summary: "Flush locally persisted work to the Hub (local state only; accepts no Hub commands).",
        options: [],
        example: "allinai-agentkit sync",
      },
      {
        name: "doctor",
        summary:
          "Self-check: git availability, config validity, pairing status and " +
          "per-runtime install probes. Exit code 0 only when git and config are OK.",
        options: [],
        example: "allinai-agentkit doctor",
      },
      {
        name: "projects",
        summary: "List locally registered project working directories.",
        options: [],
        example: "allinai-agentkit projects",
      },
      {
        name: "project",
        summary:
          "Register or remove a project working directory. Hub agent.run " +
          "payloads may select a registered project by name; the Hub can never " +
          "pick arbitrary local paths.",
        options: [
          { flag: "name", description: "Project name", required: true },
          { flag: "path", description: "Absolute directory to register (conflicts with --remove)" },
          { flag: "remove", description: "Remove the named project" },
        ],
        example: "allinai-agentkit project --name web --path /work/web",
      },
      {
        name: "plugins",
        summary: "List installed plugins; --refresh re-reports them to the Hub.",
        options: [{ flag: "refresh", description: "Re-report plugins to the Hub" }],
        example: "allinai-agentkit plugins --refresh",
      },
      {
        name: "docs",
        summary:
          "Print this manual. Markdown by default; --json emits the same " +
          "content as one structured document for strict machine parsing.",
        options: [{ flag: "json", description: "Emit the manual as JSON instead of Markdown" }],
        example: "allinai-agentkit docs --json",
      },
    ],
    configFields: [
      { field: "hubBaseUrl", description: "Hub base URL (http/https, set by init/login)" },
      { field: "clientId", description: "Unique client identity used for pairing and credentials" },
      { field: "maxConcurrentRuns", description: "Parallel agent.run executions, integer 1-32, default 1" },
      {
        field: "policy.autoRuntimes",
        description: "Runtime names that execute without approval; everything else requires approval",
      },
      {
        field: "policy.autoPermissions",
        description: "Pre-approved capability permissions (e.g. network, workspace:write)",
      },
      { field: "policy.allowedGitOrigins", description: "Optional stricter allowlist of Git origins; empty trusts any HTTPS/SSH URL (post-clone validation still applies)" },
      { field: "policy.deniedPluginIds", description: "Plugin IDs that must never activate" },
      { field: "policy.allowedWorkspaceRoots", description: "Roots capability invocations may use as workspace" },
      { field: "projects", description: "Locally registered { name, path, dir } working directories; dir is the session-record suffix generated at registration" },
    ],
    filesystem: [
      { path: "~/.allinai/agent/config.json", description: "Client config (mode 0600)" },
      { path: "~/.allinai/agent/state.db", description: "SQLite execution state, survives restarts" },
      { path: "~/.allinai/agent/credentials/", description: "Token store: one mode-0600 file per clientId, identical on every platform" },
      { path: "~/.allinai/agent/plugins/", description: "Plugin revisions (immutable, per commit)" },
      { path: "~/.allinai/agent/projects/default/runtime/<platform>/<executionId>/", description: "Disposable scratch cwd for runs without a bound project" },
      { path: "~/.allinai/agent/projects/default/sessions/<executionId>/", description: "Session records (events.jsonl + session.json) for default runs" },
      { path: "~/.allinai/agent/projects/<name>-<dir>/sessions/<executionId>/", description: "Session records for runs bound to a registered project (cwd stays the configured project path)" },
      { path: "~/.allinai/agent/logs/agent.log", description: "Rotating JSONL log, written verbatim" },
      { path: "~/.allinai/agent/control.sock", description: "Local control-plane Unix socket (also the single-instance lock)" },
    ],
    recipes: [
      {
        title: "First-time setup with the local Console",
        description: "Bring up a local Hub and pair a client against it.",
        steps: [
          "allinai-agentkit web",
          "allinai-agentkit login --hub http://127.0.0.1:4317",
          "allinai-agentkit daemon",
          "allinai-agentkit status",
        ],
      },
      {
        title: "Headless server / CI pairing without a browser",
        description: "Pair directly with a pre-issued token; no browser needed.",
        steps: [
          "allinai-agentkit init --hub https://hub.example --token <TOKEN>",
          "allinai-agentkit doctor",
          "allinai-agentkit install   # start at login; or run `daemon` under your own supervisor",
        ],
      },
      {
        title: "Register a project directory for Hub runs",
        description: "agent.run payloads may then select it via payload.project; the run's cwd is the configured path and its session records land under projects/<name>-<dir>/sessions/.",
        steps: [
          "allinai-agentkit project --name web --path /work/web",
          "allinai-agentkit projects",
          "allinai-agentkit restart   # optional; running daemons also pick it up on the next agent.run",
        ],
      },
      {
        title: "Trigger a run from the Console",
        description: "The Console UI's run form posts to /_agentkit/console/runs, which enqueues an agent.run offer; the client's local policy still gates it.",
        steps: [
          "allinai-agentkit web",
          "# open http://127.0.0.1:4317, pick a client, runtime and project, then submit a prompt",
        ],
      },
      {
        title: "Diagnose a silent daemon",
        description: "When the client seems connected but never runs anything.",
        steps: [
          "allinai-agentkit status",
          "allinai-agentkit doctor",
          "allinai-agentkit logs",
          "allinai-agentkit plugins",
        ],
      },
    ],
    agentNotes: [
      "Every command prints one JSON document per line; parse the last stdout line as JSON.",
      "--config-dir PATH works on every command and replaces the default home ~/.allinai/agent.",
      "--help on any command prints this style of usage text and never executes side effects.",
      "daemon, web and logs -f block the foreground until interrupted; everything else returns immediately.",
      "Commands that talk to the daemon (status, sync, logs, plugins, doctor credentials) require it to be running, except doctor which also works standalone.",
      "login/init write mode-0600 config and token files under the Agent home; tokens stay on this machine — do not echo them into shared channels.",
      "agent runtimes (codex / claude / pi / zcode) are optional peer dependencies: doctor reports which are installed.",
    ],
  };
}

function optionText(option: ManualOption): string {
  const required = option.required ? " (required)" : "";
  return `- \`--${option.flag}\`${required} — ${option.description}`;
}

/** Render the manual as Markdown for humans and LLM agents. */
export function renderManualMarkdown(manual: CliManual): string {
  const lines: string[] = [];
  lines.push(`# ${manual.package} CLI manual`);
  lines.push("", manual.overview, "");
  lines.push("## Quickstart", "");
  for (const step of manual.quickstart) lines.push(
    step.startsWith("allinai-agentkit") ? `- \`${step}\`` : `- ${step}`,
  );
  lines.push("", "## Commands", "");
  for (const command of manual.commands) {
    lines.push(`### ${command.name}`, "", command.summary, "");
    lines.push("```sh", command.example, "```", "");
    if (command.longRunning) lines.push("Blocks until interrupted.", "");
    if (command.options.length > 0) {
      lines.push("Options:", "");
      for (const option of command.options) lines.push(optionText(option));
      lines.push("");
    }
  }
  lines.push("## Global options", "", "- `--config-dir PATH` — use a different Agent home instead of `~/.allinai/agent`.", "- `--help` — print usage; never executes side effects.", "");
  lines.push("## config.json fields", "", "| Field | Meaning |", "|---|---|");
  for (const field of manual.configFields) {
    lines.push(`| \`${field.field}\` | ${field.description} |`);
  }
  lines.push("", "## On-disk layout", "");
  for (const entry of manual.filesystem) {
    lines.push(`- \`${entry.path}\` — ${entry.description}`);
  }
  lines.push("", "## Recipes", "");
  for (const recipe of manual.recipes) {
    lines.push(`### ${recipe.title}`, "", recipe.description, "");
    for (const step of recipe.steps) lines.push(`- \`${step}\``);
    lines.push("");
  }
  lines.push("## Notes for AI agents", "");
  for (const note of manual.agentNotes) lines.push(`- ${note}`);
  lines.push("");
  return lines.join("\n");
}
