import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(tmpdir(), "agentkit-artifacts-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tar = process.platform === "win32" ? "tar.exe" : "tar";
const consumers = {};
const offline = process.argv.includes("--offline");

function runNode(code, cwd, flags = []) {
  execFileSync(process.execPath, [...flags, "--input-type=module", "--eval", code], { cwd, stdio: "inherit", timeout: 30_000 });
}

// Offline consumers resolve exactly the dependency versions already installed
// from the workspace lockfile, rather than an uncached newer semver match.
function cachedOverrides(side) {
  const versions = {};
  const seen = new Set();
  function visit(manifestPath) {
    if (seen.has(manifestPath)) return;
    seen.add(manifestPath);
    const parent = JSON.parse(readFileSync(manifestPath, "utf8"));
    const require = createRequire(manifestPath);
    for (const name of Object.keys(parent.dependencies ?? {})) {
      // Some dependencies hide package.json behind their exports map. Resolve
      // installed metadata through Node's search paths without loading code.
      const childPath = (require.resolve.paths(name) ?? [])
        .map((base) => path.join(base, name, "package.json"))
        .find((candidate) => existsSync(candidate));
      assert.ok(childPath, `Missing installed dependency ${name} required by ${parent.name}`);
      const resolved = realpathSync(childPath);
      const child = JSON.parse(readFileSync(resolved, "utf8"));
      assert.ok(!versions[name] || versions[name] === child.version, `Offline dependency graph has multiple versions of ${name}`);
      versions[name] = child.version;
      visit(resolved);
    }
  }
  visit(path.join(workspaceRoot, "packages", side, "package.json"));
  return versions;
}

try {
  for (const side of ["client", "hub"]) {
    const stage = path.join(workspaceRoot, ".publish-stage", side);
    assert.ok(existsSync(stage), `Missing ${stage}; run publish-stage.mjs stage first`);
    const packed = JSON.parse(execFileSync(npm, ["pack", "--json", "--pack-destination", scratch], { cwd: stage, encoding: "utf8" }));
    assert.equal(packed.length, 1);
    const tarball = path.join(scratch, packed[0].filename);
    const manifest = JSON.parse(execFileSync(tar, ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
    const entries = new Set(execFileSync(tar, ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n"));
    assert.equal(manifest.name, `@allin-ai/agentkit-${side}`);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.private, false);
    assert.equal(manifest.exports[side === "hub" ? "./client" : "./hub"], undefined);
    for (const value of Object.values(manifest.exports)) {
      for (const target of typeof value === "string" ? [value] : Object.values(value)) {
        assert.match(target, /^\.\/dist\//);
        assert.ok(entries.has(`package/${target.slice(2)}`), `Missing ${target}`);
      }
    }
    for (const entry of entries) {
      assert.ok(!entry.includes("node_modules/") && !entry.includes(".codegraph/") && !entry.includes(".next/cache/"), `Unexpected development data: ${entry}`);
      assert.ok(!/\.test\.[cm]?[jt]sx?$/.test(entry), `Unexpected test: ${entry}`);
      assert.ok(!/\.(?:ts|tsx)$/.test(entry) || entry.endsWith(".d.ts"), `Unexpected TypeScript source: ${entry}`);
      assert.ok(!entry.startsWith(`package/dist/${side === "hub" ? "client" : "hub"}/`), `Other side leaked into ${side}: ${entry}`);
    }
    const manifestText = JSON.stringify(manifest);
    assert.ok(!manifestText.includes("workspace:"), "Published manifest retained a workspace reference");
    assert.equal(manifest.dependencies?.[`@allin-ai/agentkit-${side === "hub" ? "client" : "hub"}`], undefined);
    const consumer = path.join(scratch, `${side}-consumer`);
    consumers[side] = consumer;
    writeFileSync(path.join(scratch, `${side}-manifest.json`), JSON.stringify(manifest));
    mkdirSync(consumer, { recursive: true });
    const fixture = { private: true, type: "module", dependencies: { [manifest.name]: `file:${tarball}` } };
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify(fixture));
    if (offline) {
      writeFileSync(path.join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: ["."], overrides: cachedOverrides(side) }));
      // Use the same npm tarballs with cached registry dependencies when the
      // registry is unavailable. The consumer remains outside the workspace.
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      execFileSync(pnpm, ["install", "--dir", consumer, "--offline", "--prod", "--no-optional", "--ignore-scripts", "--no-frozen-lockfile"],
        { stdio: "inherit", timeout: 120_000, killSignal: "SIGKILL" });
    } else {
      execFileSync(npm, ["install", "--prefix", consumer, "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund",
        "--prefer-offline", "--fetch-timeout=120000", "--fetch-retries=1"], { stdio: "inherit", timeout: 600_000, killSignal: "SIGKILL" });
    }
    const packageDir = path.join(consumer, "node_modules", ...manifest.name.split("/"));
    for (const dependency of ["@allin-ai/agentkit-hub", "@allin-ai/agentkit-client", "@openai/codex-sdk", "@anthropic-ai/claude-agent-sdk", "@earendil-works/pi-coding-agent", ...(side === "client" ? ["react", "react-dom", "next", "@types/react"] : [])]) {
      if (dependency === manifest.name) continue;
      assert.ok(!existsSync(path.join(consumer, "node_modules", ...dependency.split("/"))), `Unexpected dependency: ${dependency}`);
    }
    runNode(`for (const entry of ${JSON.stringify(Object.keys(manifest.exports).filter((entry) => typeof manifest.exports[entry] !== "string"))}) {
      await import(${JSON.stringify(manifest.name)} + (entry === "." ? "" : entry.slice(1)));
    }`, consumer);
    if (side === "hub") runNode('import { createAgentHub } from "@allin-ai/agentkit-hub"; if (typeof createAgentHub !== "function") throw new Error("Missing SDK");', consumer, ["--no-experimental-sqlite"]);
    const bin = path.join(packageDir, Object.values(manifest.bin)[0]);
    const help = execFileSync(process.execPath, [bin, "--help"], { encoding: "utf8", timeout: 10_000 });
    assert.match(help, side === "hub" ? /allinai-agentkit-hub web/ : /allinai-agentkit <init\|login\|daemon/);
    const typeImports = side === "hub"
      ? 'import { createAgentHub, type HubStore } from "@allin-ai/agentkit-hub"; import type { ConsoleRuntime } from "@allin-ai/agentkit-hub/console"; import type { ConsoleApp } from "@allin-ai/agentkit-hub/console-ui"; import type { IssueStore } from "@allin-ai/agentkit-hub/issues"; import type { startWebHost } from "@allin-ai/agentkit-hub/web"; const factory: typeof createAgentHub = createAgentHub;'
      : 'import { ClientSupervisor, type AgentConfig, createRunnerManager } from "@allin-ai/agentkit-client"; import type { ClientTransport } from "@allin-ai/agentkit-client/client"; const factory: typeof createRunnerManager = createRunnerManager;';
    writeFileSync(path.join(consumer, "consumer.ts"), typeImports);
    writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, types: ["node"], typeRoots: [path.join(workspaceRoot, "node_modules/@types")] }, include: ["consumer.ts"] }));
    execFileSync(process.execPath, [path.join(workspaceRoot, "node_modules/typescript/bin/tsc"), "-p", path.join(consumer, "tsconfig.json")], { stdio: "inherit", timeout: 30_000 });
    console.log(`Verified isolated ${manifest.name} install, public imports, CLI and declarations (${packed[0].size} bytes packed).`);
  }
  const smoke = path.join(consumers.hub, "artifact-smoke.mjs");
  cpSync(path.join(workspaceRoot, "scripts/artifact-smoke.mjs"), smoke);
  execFileSync(process.execPath, [smoke, path.join(consumers.client, "node_modules/@allin-ai/agentkit-client"), path.join(workspaceRoot, "bin/allinai-agentkit-hub")], {
    cwd: consumers.hub, stdio: "inherit", timeout: 60_000, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
