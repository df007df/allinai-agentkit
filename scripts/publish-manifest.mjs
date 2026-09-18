import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(packageRoot, "package.json");
const backupPath = path.join(packageRoot, ".publish-manifest-backup.json");

function writeJson(filename, value) {
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function prepare() {
  if (existsSync(backupPath)) {
    throw new Error("A publish manifest backup already exists; run postpack recovery before packing again.");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const publishConfig = manifest.publishConfig;
  if (!publishConfig?.exports || !publishConfig.main || !publishConfig.types) {
    throw new Error("publishConfig must declare main, types, and exports for the published artifact.");
  }

  writeJson(backupPath, manifest);
  writeJson(manifestPath, {
    ...manifest,
    main: publishConfig.main,
    types: publishConfig.types,
    exports: publishConfig.exports,
  });
}

function restore() {
  if (!existsSync(backupPath)) return;
  renameSync(backupPath, manifestPath);
}

const command = process.argv[2];
if (command === "prepare") prepare();
else if (command === "restore") restore();
else throw new Error("Usage: node scripts/publish-manifest.mjs <prepare|restore>");
