import type { RuntimeId } from "./protocol/index.js";

export type PluginConfig = {
  id: string;
  gitUrl: string;
  ref?: string;
  /** Pin an exact commit; takes precedence over ref when both are present. */
  commit?: string;
  /**
   * What to do when the local repository has diverged (tracked edits or
   * local commits ahead of the fetched ref). "auto" (default) keeps the
   * local state and reports it; "force" overwrites with the desired state.
   */
  updatePolicy?: "auto" | "force";
  enabled: boolean;
  runtimes?: RuntimeId[];
  /**
   * Who registered this plugin: "hub" (desired state pushed from the Hub)
   * or "local" (installed via the CLI on this machine). Locally registered
   * plugins survive Hub full-state pushes — only a local remove uninstalls
   * them.
   */
  origin?: "hub" | "local";
};
