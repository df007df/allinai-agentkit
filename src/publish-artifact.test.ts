import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { transformManifest } from "../scripts/publish-stage.mjs";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

describe("published agent client artifact", () => {
  it("declares a production target for every source export", () => {
    const sourceManifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      version?: unknown;
      private?: unknown;
      engines?: { node?: unknown };
      exports?: Record<string, unknown>;
      publishConfig?: {
        main?: unknown;
        types?: unknown;
        exports?: Record<
          string,
          { import?: unknown; types?: unknown; default?: unknown }
        >;
      };
      scripts?: Record<string, unknown>;
    };

    assert.match(
      String(sourceManifest.version),
      /^\d+\.\d+\.\d+$/,
      "version must be a plain semver release number",
    );
    assert.equal(sourceManifest.private, false);
    assert.equal(sourceManifest.engines?.node, ">=22.18.0");
    assert.equal(
      sourceManifest.publishConfig?.exports?.["./hub/testkit"]?.import,
      "./dist/hub/testkit/index.js",
    );
    assert.ok(sourceManifest.exports);
    assert.equal(sourceManifest.publishConfig?.main, "./dist/index.js");
    assert.equal(sourceManifest.publishConfig?.types, "./dist/index.d.ts");

    for (const exportPath of [
      ".",
      "./protocol",
      "./hub",
      "./hub/testkit",
      "./client",
    ]) {
      assert.ok(
        sourceManifest.exports?.[exportPath],
        `${exportPath} must remain a development public entrypoint`,
      );
      assert.ok(
        sourceManifest.publishConfig?.exports?.[exportPath],
        `${exportPath} must remain a production public entrypoint`,
      );
    }

    for (const scriptName of [
      "test",
      "typecheck",
      "build",
      "publish:stage",
      "verify:artifact",
    ]) {
      const script = sourceManifest.scripts?.[scriptName];
      assert.equal(
        typeof script,
        "string",
        `${scriptName} must be package-local`,
      );
      if (typeof script !== "string") continue;
      assert.doesNotMatch(
        script,
        /\b(?:pnpm|npm)\b/,
        `${scriptName} must not depend on a global package manager`,
      );
    }

    for (const exportPath of Object.keys(sourceManifest.exports ?? {})) {
      const target:
        | {
            import?: unknown;
            types?: unknown;
            default?: unknown;
          }
        | undefined = sourceManifest.publishConfig?.exports?.[exportPath];
      assert.equal(
        typeof target?.types,
        "string",
        `${exportPath} must expose types`,
      );
      assert.equal(
        typeof target?.import,
        "string",
        `${exportPath} must expose ESM`,
      );
      assert.equal(
        target?.import,
        target?.default,
        `${exportPath} must keep one ESM target`,
      );
    }
  });

  it("must not rewrite the manifest from prepack hooks", () => {
    const sourceManifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, unknown> };

    // npm publish packs the manifest it loaded before lifecycle hooks run, so
    // a prepack rewrite ships the development manifest to the registry. The
    // staging-directory publish is the only supported layout.
    assert.equal(sourceManifest.scripts?.prepack, undefined);
    assert.equal(sourceManifest.scripts?.postpack, undefined);
  });

  it("stages the publish manifest from publishConfig", () => {
    const sourceManifest = JSON.parse(
      readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
    ) as {
      bin?: unknown;
      dependencies?: unknown;
      exports?: Record<string, unknown>;
      publishConfig?: {
        access?: unknown;
        exports?: Record<
          string,
          { import?: unknown; types?: unknown; default?: unknown }
        >;
        main?: unknown;
        types?: unknown;
      };
    };
    const staged = transformManifest(sourceManifest) as {
      main?: unknown;
      types?: unknown;
      exports?: Record<
        string,
        { import?: unknown; types?: unknown; default?: unknown }
      >;
      scripts?: unknown;
      files?: unknown;
      bin?: unknown;
      dependencies?: unknown;
      publishConfig?: { access?: unknown };
    };

    assert.equal(staged.main, sourceManifest.publishConfig?.main);
    assert.equal(staged.types, sourceManifest.publishConfig?.types);
    assert.equal(staged.exports, sourceManifest.publishConfig?.exports);
    assert.equal(staged.scripts, undefined);
    assert.equal(staged.files, undefined);
    assert.deepEqual(staged.bin, sourceManifest.bin);
    assert.deepEqual(staged.dependencies, sourceManifest.dependencies);
    assert.equal(staged.publishConfig?.access, "public");

    for (const [exportPath, target] of Object.entries(staged.exports ?? {})) {
      assert.match(
        String(target.import),
        /^\.\/dist\/.+\.js$/,
        `${exportPath} must import compiled ESM`,
      );
      assert.equal(target.default, target.import);
      assert.match(
        String(target.types),
        /^\.\/dist\/.+\.d\.ts$/,
        `${exportPath} must expose compiled declarations`,
      );
    }
  });
});
