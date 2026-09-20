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
  if (publishConfig.access) {
    staged.publishConfig = { access: publishConfig.access };
  } else {
    delete staged.publishConfig;
  }
  return staged;
}

function runBuild() {
  // build.mjs spawns tsc bare, so it needs node_modules/.bin on PATH when run
  // outside an npm/pnpm lifecycle.
  const binDir = path.join(packageRoot, "node_modules", ".bin");
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "build.mjs")],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("build failed; run `pnpm build` for details");
  }
}

function stage() {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  runBuild();
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  for (const entry of ["dist", "bin", "web", "README.md", "LICENSE"]) {
    const source = path.join(packageRoot, entry);
    if (!existsSync(source)) {
      throw new Error(`Missing publish input: ${entry}`);
    }
    cpSync(source, path.join(stageDir, entry), {
      recursive: true,
      dereference: true,
    });
  }
  writeFileSync(
    path.join(stageDir, "package.json"),
    `${JSON.stringify(transformManifest(manifest), null, 2)}\n`,
    "utf8",
  );
  console.log(`Staged ${manifest.name}@${manifest.version} at ${stageDir}`);
}

function publish(extraArgs) {
  stage();
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["publish", stageDir, ...extraArgs], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
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
  } else {
    console.error(
      "Usage: node scripts/publish-stage.mjs <stage|publish> [npm publish flags]",
    );
    process.exit(1);
  }
}
