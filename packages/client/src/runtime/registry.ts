import {
  createClaudeAdapter,
  type ClaudeAdapter,
  type CreateClaudeAdapterDeps,
} from "./claude.js";
import {
  createCodexAdapter,
  type CodexAdapter,
  type CreateCodexAdapterDeps,
} from "./codex.js";
import {
  createPiAdapter,
  type CreatePiAdapterDeps,
  type PiAdapter,
} from "./pi.js";
import { createZCodeAdapter, type ZCodeAdapter } from "./zcode.js";
import type { PlatformId } from "./types.js";

export type RegisteredPlatformAdapter =
  | CodexAdapter
  | ClaudeAdapter
  | PiAdapter
  | ZCodeAdapter;

export type PlatformAdapterFor<T extends PlatformId> = Extract<
  RegisteredPlatformAdapter,
  { readonly id: T }
>;

export type PlatformAdapterRegistry = {
  get<T extends PlatformId>(id: T): PlatformAdapterFor<T>;
  list(): readonly RegisteredPlatformAdapter[];
};

export type CreatePlatformAdapterRegistryDeps = {
  codex?: CreateCodexAdapterDeps;
  claude?: CreateClaudeAdapterDeps;
  pi?: CreatePiAdapterDeps;
  /**
   * Environment every CLI child inherits across all platforms (proxy merge
   * happens before this). Per-platform deps still win when they set their
   * own childEnv.
   */
  childEnv?: NodeJS.ProcessEnv;
};

/** Creates one explicit adapter per supported runtime without vendor fallback. */
export function createPlatformAdapterRegistry(
  deps: CreatePlatformAdapterRegistryDeps = {},
): PlatformAdapterRegistry {
  const sharedEnv = deps.childEnv;
  const adapters = {
    codex: createCodexAdapter({
      ...(sharedEnv ? { childEnv: sharedEnv } : {}),
      ...deps.codex,
    }),
    claude: createClaudeAdapter({
      ...(sharedEnv ? { childEnv: sharedEnv } : {}),
      ...deps.claude,
    }),
    pi: createPiAdapter({
      ...(sharedEnv ? { childEnv: sharedEnv } : {}),
      ...deps.pi,
    }),
    zcode: createZCodeAdapter(),
  };

  return {
    get<T extends PlatformId>(id: T): PlatformAdapterFor<T> {
      return adapters[id] as unknown as PlatformAdapterFor<T>;
    },
    list(): readonly RegisteredPlatformAdapter[] {
      return Object.values(adapters);
    },
  };
}
