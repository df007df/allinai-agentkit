import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const workspaceVersion = JSON.parse(readFileSync(path.join(workspaceRoot, "package.json"), "utf8")).version;
const requested = process.argv[2];
if (requested && !["hub", "client"].includes(requested)) throw new Error(`Unknown package: ${requested}`);

for (const side of requested ? [requested] : ["client", "hub"]) {
  const packageRoot = path.join(workspaceRoot, "packages", side);
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (manifest.version !== workspaceVersion) throw new Error(`${manifest.name} version must match workspace version ${workspaceVersion}`);
  const dist = path.join(packageRoot, "dist");
  rmSync(dist, { recursive: true, force: true });
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(packageRoot, "tsconfig.build.json")], {
    cwd: workspaceRoot, stdio: "inherit",
  });
  for (const [entry, target] of Object.entries(manifest.publishConfig.exports)) {
    if (typeof target !== "string") continue;
    const destination = path.join(packageRoot, target);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(packageRoot, manifest.exports[entry]), destination);
  }
  if (side === "hub") {
    const webRoot = path.join(packageRoot, "web");
    const hubRequire = createRequire(path.join(packageRoot, "package.json"));
    const nextVersion = hubRequire("next/package.json").version;
    if (manifest.dependencies.next !== nextVersion) throw new Error(`Hub's prebuilt Web must pin its Next.js build version ${nextVersion}`);
    execFileSync(process.execPath, [hubRequire.resolve("next/dist/bin/next"), "build", webRoot], {
      cwd: packageRoot, stdio: "inherit", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    const webDist = path.join(dist, "hub", "web");
    cpSync(path.join(webRoot, ".next"), path.join(webDist, ".next"), {
      recursive: true,
      filter: (source) => !["cache", "types", "diagnostics"].includes(path.relative(path.join(webRoot, ".next"), source).split(path.sep)[0]),
    });
    cpSync(path.join(webRoot, "public"), path.join(webDist, "public"), { recursive: true });
    cpSync(path.join(webRoot, "next.config.mjs"), path.join(webDist, "next.config.mjs"));
  }
  const targets = [manifest.publishConfig.main, manifest.publishConfig.types,
    ...Object.values(manifest.publishConfig.exports).flatMap((value) => typeof value === "string" ? [value] : Object.values(value))];
  for (const target of targets) {
    if (!target.startsWith("./dist/") || !existsSync(path.join(packageRoot, target))) throw new Error(`Missing production target: ${manifest.name} ${target}`);
  }
  console.log(`Built ${manifest.name}@${manifest.version}`);
}
