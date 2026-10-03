import { runHubCli } from "./commands.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const result = await runHubCli(args);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
