import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleState } from "./state.js";
import type { HubObservation } from "./observable-store.js";

export type ConsoleStreamContext = {
  state: ConsoleState;
  subscribers: Set<ServerResponse>;
  sequence: { value: number };
  hostWarning: string | null;
};

/** SSE: first `event: snapshot` with ConsoleSnapshot+warning, then lives. */
export function handleConsoleObserve(
  context: ConsoleStreamContext,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `event: snapshot\ndata: ${JSON.stringify({
      ...context.state.snapshot(),
      warning: context.hostWarning,
    })}\n\n`,
  );
  context.subscribers.add(response);
  const ping = setInterval(() => response.write(": ping\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(ping);
    context.subscribers.delete(response);
  });
}

/** Fan out to all subscribers; SSE frames use `event: observation`. */
export function broadcastConsole(
  context: ConsoleStreamContext,
  observation: HubObservation,
): void {
  const payload = `event: observation\ndata: ${JSON.stringify({
    seq: (context.sequence.value += 1),
    observation,
  })}\n\n`;
  for (const response of context.subscribers) response.write(payload);
}
