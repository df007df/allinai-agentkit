import type { ClientEvent } from "../protocol/index.js";

export type ExecutionView = {
  executionId: string;
  state: ClientEvent["type"];
  lastOccurredAt: string;
  eventCount: number;
};

function compareEvents(a: ClientEvent, b: ClientEvent): number {
  return a.occurredAt.localeCompare(b.occurredAt) || a.eventSeq - b.eventSeq;
}

/** Group events per execution; each view carries the latest state
 * (max `(occurredAt, eventSeq)`), its timestamp and the event count.
 * Views are sorted most recent first. */
export function deriveExecutions(
  events: readonly ClientEvent[],
): ExecutionView[] {
  const groups = new Map<string, { latest: ClientEvent; count: number }>();
  for (const event of events) {
    const group = groups.get(event.executionId);
    if (!group) {
      groups.set(event.executionId, { latest: event, count: 1 });
      continue;
    }
    group.count += 1;
    if (compareEvents(event, group.latest) > 0) group.latest = event;
  }
  return [...groups.entries()]
    .map(([executionId, { latest, count }]) => ({
      executionId,
      state: latest.type,
      lastOccurredAt: latest.occurredAt,
      eventCount: count,
    }))
    .sort((a, b) => b.lastOccurredAt.localeCompare(a.lastOccurredAt));
}

/** All events for one execution, ordered by `eventSeq` ascending. */
export function eventsForExecution(
  events: readonly ClientEvent[],
  executionId: string,
): ClientEvent[] {
  return events
    .filter((event) => event.executionId === executionId)
    .sort((a, b) => a.eventSeq - b.eventSeq);
}
