import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tar = process.platform === "win32" ? "tar.exe" : "tar";
const sourceManifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);
let tarball;
let packDir;
let consumerDir;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseNpmPackOutput(output) {
  const lines = output.trim().split("\n");
  for (let start = 0; start < lines.length; start += 1) {
    try {
      const value = JSON.parse(lines.slice(start).join("\n"));
      if (Array.isArray(value)) return value;
    } catch {
      // Lifecycle output may precede the final JSON line from npm pack.
    }
  }
  throw new Error("npm pack did not produce a JSON artifact list");
}

function readArtifactManifest(filename) {
  return JSON.parse(
    execFileSync(tar, ["-xOf", filename, "package/package.json"], {
      encoding: "utf8",
    }),
  );
}

function getProductionTargets(manifest) {
  const exports = manifest.exports;
  assert(
    exports && typeof exports === "object",
    "packed manifest must declare exports",
  );
  return Object.entries(exports).flatMap(([entrypoint, target]) => {
    assert(
      target && typeof target === "object",
      `packed export ${entrypoint} must be an object`,
    );
    const { import: esm, default: fallback, types } = target;
    assert(
      typeof esm === "string" && esm.endsWith(".js"),
      `${entrypoint} must target compiled ESM`,
    );
    assert(
      typeof types === "string" && types.endsWith(".d.ts"),
      `${entrypoint} must target declarations`,
    );
    assert(
      fallback === esm,
      `${entrypoint} must have one ESM import/default target`,
    );
    return [esm, types];
  });
}

function assertTarballContents(filename, manifest) {
  const entries = execFileSync(tar, ["-tzf", filename], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const listed = new Set(entries);
  const requireEntry = (entry) =>
    assert(listed.has(entry), `tarball missing ${entry}`);

  requireEntry("package/package.json");
  requireEntry("package/README.md");
  for (const target of getProductionTargets(manifest)) {
    requireEntry(`package/${target.slice(2)}`);
  }
  for (const webAsset of [
    "web/index.html",
    "web/login.html",
    "web/app.js",
    "web/style.css",
  ]) {
    requireEntry(`package/${webAsset}`);
  }

  for (const entry of entries) {
    assert(
      !entry.startsWith("package/src/"),
      `tarball must not include source: ${entry}`,
    );
    assert(
      !entry.includes(".codegraph/"),
      `tarball must not include codegraph data: ${entry}`,
    );
    assert(
      !entry.includes("pnpm-workspace"),
      `tarball must not include workspace files: ${entry}`,
    );
    assert(
      !/\.test\.[cm]?[jt]sx?$/.test(entry),
      `tarball must not include tests: ${entry}`,
    );
  }
}

function assertHubOnlyConsumer(manifest) {
  assert(
    typeof manifest.name === "string" && manifest.name.length > 0,
    "packed manifest must have a name",
  );
  consumerDir = mkdtempSync(
    path.join(tmpdir(), "agent-client-artifact-consumer-"),
  );
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  execFileSync(
    npm,
    ["install", "--omit=optional", "--ignore-scripts", tarball],
    {
      cwd: consumerDir,
      stdio: "inherit",
    },
  );

  for (const optionalPackage of Object.keys(
    sourceManifest.peerDependenciesMeta ?? {},
  )) {
    assert(
      !existsSync(
        path.join(consumerDir, "node_modules", ...optionalPackage.split("/")),
      ),
      `Hub-only consumer unexpectedly installed optional SDK ${optionalPackage}`,
    );
  }

  const moduleSpecifier = `${manifest.name}/hub`;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createAgentHub } from ${JSON.stringify(moduleSpecifier)};\nif (typeof createAgentHub !== \"function\") throw new Error(\"hub export missing createAgentHub\");`,
    ],
    { cwd: consumerDir, stdio: "inherit" },
  );

  const demoSpecifier = `${manifest.name}/demo`;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { startDemoSite } from ${JSON.stringify(demoSpecifier)};\nif (typeof startDemoSite !== \"function\") throw new Error(\"demo export missing startDemoSite\");`,
    ],
    { cwd: consumerDir, stdio: "inherit" },
  );
}

try {
  packDir = mkdtempSync(path.join(tmpdir(), "agent-client-artifact-pack-"));
  const packed = parseNpmPackOutput(
    execFileSync(npm, ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageRoot,
      encoding: "utf8",
    }),
  );
  assert(
    Array.isArray(packed) && packed.length === 1,
    "npm pack must emit exactly one tarball",
  );
  assert(
    typeof packed[0]?.filename === "string",
    "npm pack did not return a tarball filename",
  );
  tarball = path.join(packDir, packed[0].filename);
  assert(existsSync(tarball), `npm pack did not create ${tarball}`);

  const artifactManifest = readArtifactManifest(tarball);
  assertTarballContents(tarball, artifactManifest);
  assertHubOnlyConsumer(artifactManifest);
  console.log("Verified clean Hub-only install from packaged artifact.");
} finally {
  if (consumerDir) rmSync(consumerDir, { recursive: true, force: true });
  if (tarball) rmSync(tarball, { force: true });
  if (packDir) rmSync(packDir, { recursive: true, force: true });
}
