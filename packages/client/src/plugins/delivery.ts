import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginManifest, PluginWarning } from "./types.js";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

type SkillFrontmatter = {
  name?: string;
  description?: string;
};

/**
 * Delivery entry files each runtime platform requires inside a synced
 * plugin repository. Claude also needs a marketplace entry; Codex needs a
 * plugin.json; Pi reads the conventional package.json `pi.skills`.
 */
export type DeliveryEntry = {
  platform: DeliveryWarningPlatform;
  /** Path relative to the plugin root; missing files become warnings. */
  requiredFiles: string[];
};

function deliveryEntries(): DeliveryEntry[] {
  return [
    { platform: "claude", requiredFiles: [".claude-plugin/marketplace.json"] },
    {
      platform: "codex",
      requiredFiles: [".codex-plugin/plugin.json", ".agents/plugins/marketplace.json"],
    },
    { platform: "pi", requiredFiles: ["package.json"] },
  ];
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const match = FRONTMATTER.exec(raw);
  if (!match) return {};
  const result: SkillFrontmatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const name = /^name:\s*(.+?)\s*$/.exec(line);
    if (name) {
      result.name = name[1]!.replace(/^["']|["']$/g, "");
      continue;
    }
    const description = /^description:\s*(.+?)\s*$/.exec(line);
    if (description) {
      result.description = description[1]!.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates one declared skill directory: SKILL.md must exist with usable
 * front-matter (a description is mandatory for every runtime; a name must
 * be present and slug-shaped so cross-platform naming stays consistent).
 */
async function validateSkillDir(
  pluginId: string,
  skillPath: string,
  warnings: PluginWarning[],
): Promise<void> {
  const absolute = path.resolve(skillPath);
  const skillMd = path.join(absolute, "SKILL.md");
  if (!(await exists(skillMd))) {
    warnings.push({
      platform: "all",
      code: "skill_missing",
      message: `Plugin ${pluginId}: skill directory "${skillPath}" has no SKILL.md; the skill cannot be delivered to any runtime`,
    });
    return;
  }
  let frontmatter: SkillFrontmatter;
  try {
    frontmatter = parseFrontmatter(await readFile(skillMd, "utf8"));
  } catch {
    warnings.push({
      platform: "all",
      code: "skill_missing",
      message: `Plugin ${pluginId}: SKILL.md in "${skillPath}" could not be read`,
    });
    return;
  }
  if (!frontmatter.description) {
    warnings.push({
      platform: "all",
      code: "skill_missing_description",
      message: `Plugin ${pluginId}: SKILL.md in "${skillPath}" has no description; runtimes (Pi especially) skip skills without one`,
    });
  }
  if (!frontmatter.name) {
    warnings.push({
      platform: "all",
      code: "skill_name_mismatch",
      message: `Plugin ${pluginId}: SKILL.md in "${skillPath}" has no name field; runtimes fall back to the directory name, which breaks cross-platform consistency`,
    });
  } else if (!SKILL_NAME.test(frontmatter.name)) {
    warnings.push({
      platform: "all",
      code: "skill_name_invalid",
      message: `Plugin ${pluginId}: skill name "${frontmatter.name}" in "${skillPath}" is not a lowercase slug (a-z, 0-9, hyphens); some runtimes will reject it`,
    });
  }
}

/**
 * Post-sync delivery check for a synced plugin repository. Everything
 * reported here is non-fatal: the plugin stays active, but the warnings
 * surface on the client (CLI/ack) and the hub so misconfigured entry
 * files are visible before a run needs the skill.
 */
export async function validateDelivery(
  repo: string,
  manifest: PluginManifest,
): Promise<PluginWarning[]> {
  const warnings: PluginWarning[] = [];
  const skills = manifest.skills ?? [];

  if (skills.length === 0) {
    // No skills declared: only meaningful if a conventional skills/ dir
    // exists but was left unlisted — that is almost certainly an oversight.
    const conventional = path.join(repo, "skills");
    if (await exists(conventional)) {
      let entries: string[] = [];
      try {
        entries = (await readdir(conventional)).filter(async () => true);
      } catch {
        entries = [];
      }
      const withSkillMd: string[] = [];
      for (const entry of entries) {
        if (await exists(path.join(conventional, entry, "SKILL.md"))) {
          withSkillMd.push(entry);
        }
      }
      if (withSkillMd.length > 0) {
        warnings.push({
          platform: "all",
          code: "skill_empty_dir",
          message: `Plugin ${manifest.id}: skills/ contains ${withSkillMd.length} skill(s) but the manifest declares no "skills" field; nothing will be delivered. Add "skills": [${withSkillMd.map((name) => `"skills/${name}"`).join(", ")}] to allinai-plugin.json`,
        });
      }
    }
    await checkEntryFiles(repo, warnings);
    return warnings;
  }

  for (const skill of skills) {
    await validateSkillDir(manifest.id, path.join(repo, skill), warnings);
  }
  await checkEntryFiles(repo, warnings);
  return warnings;
}

/** Missing platform entry files: the delivery for that platform silently no-ops. */
async function checkEntryFiles(
  repo: string,
  warnings: PluginWarning[],
): Promise<void> {
  for (const entry of deliveryEntries()) {
    for (const file of entry.requiredFiles) {
      if (!(await exists(path.join(repo, file)))) {
        warnings.push({
          platform: entry.platform,
          code: "manifest_unknown_fields",
          message: `Plugin delivery: ${file} is missing; ${describePlatform(entry.platform)} delivery will not work until it is added`,
        });
      }
    }
  }
}

export type DeliveryWarningPlatform = "claude" | "codex" | "pi" | "zcode" | "all";

function describePlatform(platform: DeliveryWarningPlatform): string {
  if (platform === "claude") return "Claude (SDK plugin loading)";
  if (platform === "codex") return "Codex (plugin marketplace)";
  if (platform === "pi") return "Pi (package skills)";
  if (platform === "zcode") return "ZCode (native skill directory)";
  return platform;
}
