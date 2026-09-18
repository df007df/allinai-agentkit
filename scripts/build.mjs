import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const manifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

function getProductionTargets() {
  const exports = manifest.publishConfig?.exports;
  if (!exports || typeof exports !== "object") {
    throw new Error(
      "publishConfig.exports must describe every packaged entrypoint.",
    );
  }

  return Object.entries(exports).flatMap(([entrypoint, target]) => {
    if (!target || typeof target !== "object") {
      throw new Error(
        `Production export ${entrypoint} must declare ESM and type targets.`,
      );
    }
    const { import: esm, default: fallback, types } = target;
    if (
      typeof esm !== "string" ||
      typeof types !== "string" ||
      fallback !== esm ||
      !esm.endsWith(".js") ||
      !types.endsWith(".d.ts")
    ) {
      throw new Error(
        `Production export ${entrypoint} must declare matching .js import/default and .d.ts types targets.`,
      );
    }
    return [esm, types];
  });
}

function assertBuiltPublicTargets() {
  const required = [
    manifest.publishConfig?.main,
    manifest.publishConfig?.types,
    ...getProductionTargets(),
  ];
  for (const target of required) {
    if (typeof target !== "string" || !target.startsWith("./dist/")) {
      throw new Error(
        `Published target must be a package-local dist file: ${String(target)}`,
      );
    }
    if (!existsSync(path.join(packageRoot, target))) {
      throw new Error(`Build did not emit required public target: ${target}`);
    }
  }
}

// TypeScript leaves outputs for deleted inputs behind. Clear this package's
// artifact first so a packaged Agent Client cannot retain retired executors.
rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });

execFileSync(
  process.platform === "win32" ? "tsc.cmd" : "tsc",
  ["-p", "tsconfig.build.json"],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

assertBuiltPublicTargets();
