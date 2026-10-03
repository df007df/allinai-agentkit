/**
 * Mention protocol lifted from AllInAI mention-link/mention-parse, renamed to
 * the issue vocabulary. Two accepted forms in comment bodies:
 *
 *   [显示名](mention://agent/<id>)   — canonical link (rich editor output)
 *   @显示名                          — plain-text fallback resolved against
 *                                      the injected actor directory
 */

import type { ActorRef } from "./types.js";

export type MentionLinkType = "agent" | "member" | "issue";

export type MentionLinkHit = {
  type: MentionLinkType;
  id: string;
  label: string;
  from: number;
  to: number;
};

const MENTION_LINK_RE =
  /\[([^\]]+)\]\(mention:\/\/(agent|member|issue)\/([^)\s]+)\)/g;

export function formatMentionLink(
  type: MentionLinkType,
  id: string,
  label: string,
): string {
  return `[${label}](mention://${type}/${id})`;
}

export function findMentionLinks(text: string): MentionLinkHit[] {
  if (!text) return [];
  const hits: MentionLinkHit[] = [];
  const re = new RegExp(MENTION_LINK_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const label = match[1];
    const type = match[2] as MentionLinkType;
    const id = match[3];
    if (!label || !type || !id) continue;
    hits.push({
      type,
      id,
      label,
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return hits;
}

export type MentionActor = {
  id: string;
  displayName: string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rangesOverlap(
  a: { from: number; to: number },
  b: { from: number; to: number },
): boolean {
  return a.from < b.to && b.from < a.to;
}

/**
 * Parse comment bodies into actor mentions. Canonical agent/member links
 * win; unmatched spans fall back to longest-name-first `@displayName`
 * matches against `actors` (the agent directory). Issue links and mentions
 * of the author are excluded.
 */
export function parseAgentMentions(
  body: string,
  actors: ReadonlyArray<MentionActor>,
  options?: { excludeActorId?: string },
): ActorRef[] {
  if (!body) return [];
  const exclude = options?.excludeActorId;
  const seen = new Set<string>();
  const refs: ActorRef[] = [];
  const occupied: Array<{ from: number; to: number }> = [];

  for (const hit of findMentionLinks(body)) {
    occupied.push({ from: hit.from, to: hit.to });
    if (hit.type === "issue") continue;
    if (exclude && hit.id === exclude) continue;
    const key = `${hit.type}:${hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type: hit.type, id: hit.id });
  }

  const byName = new Map<string, MentionActor>();
  for (const actor of actors) {
    const name = actor.displayName.trim();
    if (!name || byName.has(name)) continue;
    byName.set(name, { id: actor.id, displayName: name });
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);

  for (const name of names) {
    const actor = byName.get(name)!;
    if (seen.has(`agent:${actor.id}`)) continue;
    const re = new RegExp(`(?:^|[\\s\\n])(@${escapeRegExp(name)})(?=\\s|$)`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const token = match[1]!;
      const from = match.index + (match[0].length - token.length);
      const to = from + token.length;
      if (occupied.some((range) => rangesOverlap({ from, to }, range))) continue;
      occupied.push({ from, to });
      if (exclude && actor.id === exclude) continue;
      seen.add(`agent:${actor.id}`);
      refs.push({ type: "agent", id: actor.id });
      break;
    }
  }

  return refs;
}
