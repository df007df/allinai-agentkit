import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const stageDir = path.join(packageRoot, ".publish-stage");

/**
 * npm publish packs the manifest it loaded before running lifecycle hooks, so
 * rewriting package.json in prepack ships the development manifest to the
 * registry. Publishing a staging directory whose on-disk manifest is already
 * the public one is the only layout npm cannot get wrong.
 */
export function transformManifest(manifest) {
  const publishConfig = manifest.publishConfig;
  if (!publishConfig?.exports || !publishConfig.main || !publishConfig.types) {
    throw new Error(
      "publishConfig must declare main, types, and exports for the published artifact.",
    );
  }

  const staged = {
    ...manifest,
    main: publishConfig.main,
    types: publishConfig.types,
    exports: publishConfig.exports,
  };
  delete staged.scripts;
  delete staged.files;
  delete staged.devDependencies;
  if (publishConfig.access) {
    staged.publishConfig = { access: publishConfig.access };
  } else {
    delete staged.publishConfig;
  }
  return staged;
}

function runBuild() {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "build.mjs")],
    {
      stdio: "inherit",
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("build failed; run `pnpm build` for details");
  }
}

function stage() {
  runBuild();
  rmSync(stageDir, { recursive: true, force: true });
  for (const side of ["hub", "client"]) {
    const sourceRoot = path.join(packageRoot, "packages", side);
    const destination = path.join(stageDir, side);
    const manifest = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    mkdirSync(destination, { recursive: true });
    for (const entry of ["dist", "bin", "README.md", "CHANGELOG.md", "LICENSE"]) {
      const source = path.join(["README.md", "CHANGELOG.md", "LICENSE"].includes(entry) ? packageRoot : sourceRoot, entry);
      if (!existsSync(source)) throw new Error(`Missing publish input: ${source}`);
      cpSync(source, path.join(destination, entry), { recursive: true });
    }
    writeFileSync(path.join(destination, "package.json"), `${JSON.stringify(transformManifest(manifest), null, 2)}\n`, "utf8");
    console.log(`Staged ${manifest.name}@${manifest.version} at ${destination}`);
  }
}

function publish(extraArgs) {
  stage();
  publishStaged(extraArgs);
}

export function publicationAction(result, gitHead) {
  if (result.error) throw result.error;
  let manifest;
  try { manifest = JSON.parse(result.stdout); }
  catch { throw new Error("Registry lookup failed: invalid npm response"); }
  if (result.status === 0) {
    if (manifest.gitHead === gitHead) return "skip";
    throw new Error("This version already exists from a different or unknown commit; choose a new version.");
  }
  if (manifest.error?.code === "E404") return "publish";
  throw new Error(`Registry lookup failed: ${manifest.error?.code ?? result.status}`);
}

function publishStaged(extraArgs) {
  const git = (args) => {
    const result = spawnSync("git", args, { cwd: packageRoot, encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return result.stdout.trim();
  };
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error("Commit tracked changes before publishing.");
  }
  const gitHead = git(["rev-parse", "HEAD"]);
  const version = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
  if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${version}`) {
    throw new Error(`Release tag must be v${version}`);
  }
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const side of ["hub", "client"]) {
    const directory = path.join(stageDir, side);
    const manifestPath = path.join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.name !== `@allin-ai/agentkit-${side}` || manifest.version !== version) {
      throw new Error(`Staged ${side} does not match the release; stage and verify again.`);
    }
    const spec = `${manifest.name}@${manifest.version}`;
    const lookup = spawnSync(npm, ["view", spec, "--json"], { cwd: packageRoot, encoding: "utf8" });
    if (publicationAction(lookup, gitHead) === "skip") {
      console.log(`Already published ${spec} from ${gitHead}; skipping.`);
      continue;
    }
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, gitHead }, null, 2)}\n`);
    const result = spawnSync(npm, ["publish", directory, ...extraArgs], { cwd: packageRoot, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [command, ...extraArgs] = process.argv.slice(2);

if (invokedDirectly) {
  if (command === "stage") {
    stage();
  } else if (command === "publish") {
    publish(extraArgs);
  } else if (command === "publish-staged") {
    publishStaged(extraArgs);
  } else {
    console.error(
      "Usage: node scripts/publish-stage.mjs <stage|publish|publish-staged> [npm publish flags]",
    );
    process.exit(1);
  }
}
