import { CONSOLE_OBSERVE_PATH } from "../routes.js";

export type AgentEventStream = { close(): void };

export type AgentEventStreamOptions = {
  /** SSE endpoint; defaults to the console observe path (relative). */
  url?: string;
  onSnapshot(snapshot: unknown): void;
  onObservation(observation: unknown): void;
  onStatus?(status: "connecting" | "open" | "reconnecting"): void;
};

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/** Connect to the console observe stream: `event: snapshot` carries the full
 * buffer, subsequent `event: observation` frames carry single observations.
 * On disconnect it reconnects with exponential backoff (1s → 2s → … → 30s cap)
 * and re-emits a fresh snapshot on each successful reopen. */
export function connectAgentEvents(
  options: AgentEventStreamOptions,
): AgentEventStream {
  const url = options.url ?? CONSOLE_OBSERVE_PATH;
  const { onSnapshot, onObservation, onStatus } = options;

  let source: EventSource | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  function setStatus(status: "connecting" | "open" | "reconnecting"): void {
    onStatus?.(status);
  }

  function attach(next: EventSource): void {
    next.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    next.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      setStatus("reconnecting");
      const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * 2 ** attempt,
      );
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    next.addEventListener("snapshot", (event) => {
      const snapshot = parseJson((event as MessageEvent).data);
      if (snapshot !== null) onSnapshot(snapshot);
    });
    next.addEventListener("observation", (event) => {
      const observation = parseJson((event as MessageEvent).data);
      if (observation !== null) onObservation(observation);
    });
  }

  function connect(): void {
    if (closed) return;
    setStatus(attempt === 0 ? "connecting" : "reconnecting");
    source = new EventSource(url);
    attach(source);
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      source?.close();
      source = null;
    },
  };
}
