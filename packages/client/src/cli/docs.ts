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
    package: "@allin-ai/agentkit-client",
    overview:
      "allinai-agentkit connects applications to local AI agents. The Hub " +
      "dispatches tasks and provides a web console; this Client runs Codex, " +
      "Claude, Pi or zcode on the execution machine and reports progress and results. " +
      "Use it to work in registered projects, share plugin skills, recover connections, " +
      "handle approvals and collaborate through Issues. Install and authenticate " +
      "the platform CLI separately. This manual covers Client setup, daily operations " +
      "and troubleshooting.",
    quickstart: [
      "npm install -g @allin-ai/agentkit-hub    # Hub machine: SDK and Console; Client is installed separately",
      "npm install -g @allin-ai/agentkit-client # execution machine: persistent Client and CLI",
      "allinai-agentkit-hub web    # terminal A: local Console (Hub + web UI) on http://127.0.0.1:4317; provided by @allin-ai/agentkit-hub",
      "allinai-agentkit login --hub http://127.0.0.1:4317   # terminal B: browser pairing; requires the Console running",
      "# optional: register an existing project before starting the Client; replace the path with a real absolute directory",
      "allinai-agentkit project --name web --path /absolute/path/to/your-project",
      "allinai-agentkit daemon  # terminal B: run the persistent client in the foreground",
      "# in the Console, select the online Client, an installed platform and the optional project, then submit a task",
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
          { flag: "name", description: "Display name shown on the authorize page and console" },
          { flag: "no-browser", description: "Print the authorize URL without opening a browser" },
        ],
        example: "allinai-agentkit login --hub http://127.0.0.1:4317 --no-browser",
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
        name: "issue",
        summary:
          "Issue collaboration surface for agents: show/list issues, comment " +
          "conclusions, update status or priority, and read your own inbox. " +
          "Talks to the Hub REST API with this client's stored token.",
        options: [
          { flag: "status", description: "Filter (list) or set (update) a status" },
          { flag: "priority", description: "Set a priority (update)" },
          { flag: "body", description: "Comment body (comment)", required: false },
          { flag: "json", description: "Machine-readable JSON output (show)" },
        ],
        example: "allinai-agentkit issue show ISSUE-12",
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
        summary:
          "List installed plugins; --refresh re-reports them to the Hub. Local registration: --action install registers a machine-owned plugin (survives Hub pushes; reported via inventory), --action remove unregisters it. Offline maintenance: --action check compares against upstream, --action update fetches and updates locally (no Hub needed), --action force switches one plugin to an explicit commit.",
        options: [
          { flag: "refresh", description: "Re-report plugins to the Hub" },
          { flag: "action install|remove|check|update|force", description: "Plugin management action" },
          { flag: "git-url URL", description: "Git repository URL for --action install" },
          { flag: "id PLUGIN_ID", description: "Plugin id for --action install|remove|force (install requires a lowercase slug)" },
          { flag: "ref REF", description: "Optional branch/ref for --action install" },
          { flag: "commit SHA", description: "Target commit for --action force (defaults to the last resolved commit)" },
        ],
        example:
          "allinai-agentkit plugins --action install --git-url https://github.com/me/skills.git --id my-skills",
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
      { field: "name", description: "Optional display name shown on authorize pages and consoles" },
      { field: "proxy", description: "Optional http(s) proxy URL forwarded to agent runtimes (e.g. http://127.0.0.1:7900)" },
      { field: "maxConcurrentRuns", description: "Parallel agent.run executions, integer 1-32, default 1" },
      { field: "maxTurns", description: "Maximum Claude agent turns per task, positive safe integer, default 30" },
      {
        field: "policy.requireRunApproval",
        description: "When true every agent run waits for local execution approval; default false (runs start immediately)",
      },
      {
        field: "policy.autoPermissions",
        description: "Pre-approved capability permissions (e.g. network, workspace:write)",
      },
      { field: "policy.allowedGitOrigins", description: "Optional stricter allowlist of Git origins; empty trusts any HTTPS/SSH URL (post-clone validation still applies)" },
      { field: "policy.deniedPluginIds", description: "Plugin IDs blocked for capability invocations by local policy" },
      { field: "policy.allowedWorkspaceRoots", description: "Roots capability invocations may use as workspace" },
      { field: "projects", description: "Locally registered { name, path, dir } working directories; dir is the session-record suffix generated at registration" },
    ],
    filesystem: [
      { path: "~/.allinai/agent/config.json", description: "Client config (mode 0600)" },
      { path: "~/.allinai/agent/state.db", description: "SQLite execution state, survives restarts" },
      { path: "~/.allinai/agent/credentials/", description: "Token store: one mode-0600 file per clientId, identical on every platform" },
      { path: "~/.allinai/agent/plugins/<id>/repo/", description: "Plugin working repository (one persistent clone per plugin; active commit = working tree)" },
      { path: "~/.allinai/agent/plugins/<id>/active.json", description: "Active-plugin record (mode 0600); ledger for reporting, not a dispatch pointer" },
      { path: "~/.allinai/agent/projects/default/runtime/<platform>/<executionId>/", description: "Disposable scratch cwd for runs without a bound project" },
      { path: "~/.allinai/agent/projects/default/sessions/<executionId>/", description: "Session records (events.jsonl + session.json) for default runs" },
      { path: "~/.allinai/agent/projects/<name>-<dir>/sessions/<executionId>/", description: "Session records for runs bound to a registered project (cwd stays the configured project path)" },
      { path: "~/.allinai/agent/logs/agent.log", description: "Rotating JSONL log, written verbatim" },
      { path: "~/.allinai/agent/control.sock", description: "Local control-plane Unix socket (also the single-instance lock)" },
    ],
    recipes: [
      {
        title: "Migrate from the former combined package",
        description: "The Hub and Client are independent packages. Keep existing client config and credentials; move Hub/Console/Issues imports to @allin-ai/agentkit-hub and Client imports to @allin-ai/agentkit-client.",
        steps: [
          "npm uninstall -g @allin-ai/agentkit @allin-ai/agentkit-web",
          "npm install -g @allin-ai/agentkit-client @allin-ai/agentkit-hub",
          "allinai-agentkit-hub web   # replaces allinai-agentkit web",
        ],
      },
      {
        title: "Run your first task from the local Console",
        description: "Use the Console to send a code review, investigation or documentation task to this machine. Pair the Client, optionally register a project, then keep it running while you watch task progress in the browser.",
        steps: [
          "allinai-agentkit-hub web",
          "allinai-agentkit login --hub http://127.0.0.1:4317",
          "allinai-agentkit project --name web --path /absolute/path/to/your-project   # optional; replace the path",
          "allinai-agentkit daemon",
          "# open the Console, select the Client, platform and project, then submit your task",
          "# in another terminal, check the running Client:",
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
        description: "Use a named project when tasks should inspect or edit an existing repository. Runs use its registered directory; session records stay in the Client data directory. Register before daemon startup so the initial inventory includes the project.",
        steps: [
          "allinai-agentkit project --name web --path /work/web",
          "allinai-agentkit projects",
          "# if the Client is already running, reconnect it to refresh the Console's project list; runs read the latest local registration",
          "allinai-agentkit restart   # for a Client installed as a user service",
        ],
      },
      {
        title: "Trigger a run from the Console",
        description: "Choose where a task runs and which installed Agent handles it, then watch its status and events in the Console. If task-start approval is enabled on that Client, approve the task before it begins.",
        steps: [
          "allinai-agentkit-hub web",
          "# open http://127.0.0.1:4317, pick a client, runtime and project, then submit a prompt",
        ],
      },
      {
        title: "Follow an Issue and report your conclusion",
        description: "Use Issues when a task needs background, discussion and a continuing work record. A comment mentioning a connected Agent starts an execution with Issue context; the Agent can read the full discussion, post findings and update status with these commands.",
        steps: [
          "allinai-agentkit issue list",
          "allinai-agentkit issue show ISSUE-12 --json",
          "allinai-agentkit issue comment ISSUE-12 --body \"Findings and verification results\"",
          "allinai-agentkit issue update ISSUE-12 --status in_review",
          "allinai-agentkit issue inbox",
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
      "Use docs --json and issue show ISSUE-12 --json for structured output; docs defaults to Markdown and logs streams the original log.",
      "--config-dir PATH works on every command and replaces the default home ~/.allinai/agent.",
      "--help on any command prints this style of usage text and never executes side effects.",
      "login waits for browser authorization. daemon and logs -f keep the foreground running until interrupted.",
      "Commands that query or control the daemon require it to be running. doctor can inspect the environment and config standalone; logs reads the saved log file.",
      "login/init write mode-0600 config and token files under the Agent home; tokens stay on this machine — do not echo them into shared channels.",
      "Install and authenticate a supported platform CLI (codex / claude / pi / zcode) on the execution machine before running tasks; doctor reports which commands are detected.",
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
