import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCli } from "./commands.js";
import { COMMAND_OPTIONS } from "./commands.js";
import { cliManual, type CliManual } from "./docs.js";

function capture(args: readonly string[]) {
  const output: string[] = [];
  const promise = runCli(args, { write: (line) => output.push(line) });
  return { promise, output };
}

describe("docs command", () => {
  it("renders the manual as markdown without touching the filesystem", async () => {
    const { promise, output } = capture(["docs"]);
    const result = await promise;

    assert.equal(result.exitCode, 0);
    const text = output.join("");
    for (const command of Object.keys(COMMAND_OPTIONS)) {
      assert.match(
        text,
        new RegExp(`\\b${command}\\b`),
        `manual must document ${command}`,
      );
    }
    assert.match(text, /allinai-agentkit/);
    assert.match(text, /--config-dir/);
  });

  it("emits the same manual as strict JSON with --json", async () => {
    const { promise, output } = capture(["docs", "--json"]);
    const result = await promise;

    assert.equal(result.exitCode, 0);
    const manual = JSON.parse(output.join("")) as CliManual;
    assert.equal(manual.schema, "allinai-agentkit.cli-manual");
    assert.ok(Array.isArray(manual.commands));
    assert.ok(manual.commands.length > 0);
    for (const command of manual.commands) {
      assert.ok(command.name);
      assert.ok(command.summary);
    }
    assert.ok(manual.quickstart.length > 0);
    assert.ok(manual.recipes.length > 0);
    assert.ok(manual.agentNotes.length > 0);
  });

  it("keeps the manual in lockstep with the accepted command set", () => {
    const manual = cliManual();
    const documented = new Set(manual.commands.map((command) => command.name));
    const accepted = new Set(Object.keys(COMMAND_OPTIONS));
    for (const name of accepted) {
      assert.ok(
        documented.has(name),
        `${name} is accepted by runCli but missing from the manual`,
      );
    }
    for (const name of documented) {
      assert.ok(
        accepted.has(name),
        `${name} is documented but rejected by runCli`,
      );
    }
    // Every documented command lists the same option names runCli accepts,
    // except the global --config-dir which the manual documents once.
    for (const command of manual.commands) {
      const spec = COMMAND_OPTIONS[command.name]!;
      const expected = new Set([
        ...(spec.values ?? []),
        ...(spec.booleans ?? []),
      ]);
      expected.delete("config-dir");
      const listed = new Set(
        command.options.flatMap((option) => option.flag.split(/[\s|]+/)),
      );
      for (const flag of expected) {
        assert.ok(
          listed.has(flag),
          `${command.name} accepts --${flag} but the manual omits it`,
        );
      }
    }
  });

  it("documents every recipe step that references a known command", () => {
    const manual = cliManual();
    const known = new Set(manual.commands.map((command) => command.name));
    // Recipe steps are CLI invocation lines (or "# comment" lines); any line
    // starting with the binary name must name an accepted subcommand.
    const referenced = manual.recipes.flatMap((recipe) =>
      recipe.steps
        .filter((step) => step.startsWith("allinai-agentkit "))
        .map((step) => step.replace(/^allinai-agentkit\s+/, "").split(/\s+/)[0]!),
    );
    for (const name of referenced) {
      assert.ok(known.has(name), `recipe references unknown command ${name}`);
    }
  });

  it("mentions docs from --help so agents can discover it", async () => {
    const { promise, output } = capture(["--help"]);
    const result = await promise;

    assert.equal(result.exitCode, 0);
    assert.match(output.join(""), /\bdocs\b/);
  });
});
