import { runCli } from "./commands.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const result = await runCli(args);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

// Direct `tsx src/cli/main.ts` invocation (dev path). The shipped bin entry
// imports dist and calls main() itself; without this guard the source entry
// loads the module and exits silently.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
