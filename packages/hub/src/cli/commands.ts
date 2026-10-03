import path from "node:path";

export type HubWebOptions = { port?: number; host?: string; configDir?: string; dev?: boolean };
export type HubSiteHandle = { url: string; hubUrl: string; close(): Promise<void> };
export type HubCliOptions = {
  write?: (line: string) => void;
  startWeb?: (options: HubWebOptions) => Promise<HubSiteHandle>;
  waitForShutdown?: () => Promise<void>;
};

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export async function runHubCli(
  args: readonly string[],
  options: HubCliOptions = {},
): Promise<{ exitCode: 0 | 1; output: string[] }> {
  const output: string[] = [];
  const emit = (line: string) => { output.push(line); (options.write ?? console.log)(line); };
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    emit("Usage: allinai-agentkit-hub web [--port 4317] [--host 127.0.0.1] [--config-dir PATH] [--dev]");
    return { exitCode: 0, output };
  }
  try {
    if (args[0] !== "web") throw new Error(`Unknown Hub command: ${args[0]}`);
    const flags: Record<string, string> = {};
    let dev = false;
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!;
      if (flag === "--dev") { dev = true; continue; }
      if (!["--port", "--host", "--config-dir"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      flags[flag] = value;
    }
    const port = flags["--port"] === undefined ? undefined : Number(flags["--port"]);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new Error("--port must be an integer between 0 and 65535");
    }
    const configDir = flags["--config-dir"];
    if (configDir !== undefined && !path.isAbsolute(configDir)) throw new Error("--config-dir must be an absolute path");
    const startWeb = options.startWeb ?? (async (input: HubWebOptions) => {
      const specifier = "../../web/server.js";
      const { startWebHost } = await import(specifier);
      return startWebHost(input);
    });
    const site = await startWeb({ port, host: flags["--host"], configDir, dev });
    emit(JSON.stringify({ consoleUrl: site.url, hubWsUrl: site.hubUrl }));
    try { await (options.waitForShutdown ?? waitForShutdown)(); }
    finally { await site.close(); }
    return { exitCode: 0, output };
  } catch (error) {
    emit(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    return { exitCode: 1, output };
  }
}
