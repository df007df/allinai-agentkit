import { lstat, mkdir, unlink } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import path from "node:path";
import { resolveAgentControlEndpoint, type AgentPaths } from "./paths.js";

export type AgentHealth = {
  status: "ok" | "degraded" | "unpaired";
  [key: string]: unknown;
};
export type AgentStatus = { state: string; [key: string]: unknown };

export type AgentControl = {
  health(): AgentHealth | Promise<AgentHealth>;
  approve(executionId: string): Promise<void>;
  status(): AgentStatus | Promise<AgentStatus>;
  /** Flush locally durable work; it never accepts a Hub-provided command. */
  sync?(): Promise<void>;
};

export type AgentControlServer = {
  endpoint: string;
  close(): Promise<void>;
};

export type ControlFileSystem = {
  mkdir(dir: string, options: { recursive: true }): Promise<string | undefined>;
  lstat(file: string): Promise<{ isSocket(): boolean }>;
  unlink(file: string): Promise<void>;
};

export type AgentControlServerOptions = {
  control: AgentControl;
  /** Absolute Unix socket path. On Windows provide no value and use paths. */
  socketPath?: string;
  paths?: AgentPaths;
  platform?: NodeJS.Platform;
  fileSystem?: ControlFileSystem;
  /** Test seam for stale socket probing; true means an existing endpoint is live. */
  endpointActive?: (endpoint: string) => Promise<boolean>;
  serverFactory?: (listener: (socket: Socket) => void) => Server;
};

export type AgentControlClient = {
  health(): Promise<AgentHealth>;
  approve(executionId: string): Promise<void>;
  status(): Promise<AgentStatus>;
  sync?(): Promise<void>;
};

export type AgentControlClientOptions = {
  connect?: (endpoint: string) => Socket;
  timeoutMs?: number;
};

type ControlRequest =
  | { id: string; method: "health" }
  | { id: string; method: "status" }
  | { id: string; method: "sync" }
  | { id: string; method: "approve"; executionId: string };

type ControlRequestInput =
  | { method: "health" }
  | { method: "status" }
  | { method: "sync" }
  | { method: "approve"; executionId: string };

type ControlResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

const controlFs: ControlFileSystem = { mkdir, lstat, unlink };

function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function controlError(error: unknown): string {
  return error instanceof Error ? error.message : "Control request failed";
}

function parseRequest(value: unknown): ControlRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Control request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !input.id)
    throw new TypeError("Control request id is required");
  if (input.method === "health") return { id: input.id, method: "health" };
  if (input.method === "status") return { id: input.id, method: "status" };
  if (input.method === "sync") return { id: input.id, method: "sync" };
  if (
    input.method === "approve" &&
    typeof input.executionId === "string" &&
    input.executionId
  ) {
    return { id: input.id, method: "approve", executionId: input.executionId };
  }
  throw new TypeError("Unsupported control request");
}

function defaultEndpointActive(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ path: endpoint });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function prepareUnixSocket(
  endpoint: string,
  fs: ControlFileSystem,
  endpointActive: (endpoint: string) => Promise<boolean>,
): Promise<void> {
  await fs.mkdir(path.dirname(endpoint), { recursive: true });
  try {
    const entry = await fs.lstat(endpoint);
    if (!entry.isSocket()) {
      throw new Error(
        `Refusing to remove non-socket control path: ${endpoint}`,
      );
    }
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  if (await endpointActive(endpoint)) {
    throw new Error(`Agent control socket is already active: ${endpoint}`);
  }
  await fs.unlink(endpoint);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Endpoint is always a Unix-domain socket or a Windows named pipe.
    server.listen(endpoint);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Start the local control server. Its API deliberately has no host/port field,
 * preventing an unauthenticated TCP listener from being configured here.
 */
export async function startAgentControlServer(
  options: AgentControlServerOptions,
): Promise<AgentControlServer> {
  const platform = options.platform ?? process.platform;
  const endpoint =
    options.socketPath ??
    (options.paths
      ? resolveAgentControlEndpoint(options.paths, platform)
      : undefined);
  if (!endpoint)
    throw new TypeError("socketPath or paths is required for agent control");
  if (platform !== "win32") {
    await prepareUnixSocket(
      endpoint,
      options.fileSystem ?? controlFs,
      options.endpointActive ?? defaultEndpointActive,
    );
  }

  const server = (options.serverFactory ?? createServer)(async (socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 64 * 1024) {
        socket.destroy(new Error("Control request is too large"));
        return;
      }
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        void handleLine(options.control, socket, line);
        newline = pending.indexOf("\n");
      }
    });
  });
  await listen(server, endpoint);
  return { endpoint, close: () => close(server) };
}

async function handleLine(
  control: AgentControl,
  socket: Socket,
  line: string,
): Promise<void> {
  let response: ControlResponse;
  let request: ControlRequest | undefined;
  try {
    request = parseRequest(JSON.parse(line));
    if (request.method === "health") {
      response = { id: request.id, ok: true, result: await control.health() };
    } else if (request.method === "status") {
      response = { id: request.id, ok: true, result: await control.status() };
    } else if (request.method === "sync") {
      if (!control.sync)
        throw new Error("Local Agent Client does not support sync");
      await control.sync();
      response = { id: request.id, ok: true };
    } else {
      await control.approve(request.executionId);
      response = { id: request.id, ok: true };
    }
  } catch (error) {
    response = {
      id: request?.id ?? "unknown",
      ok: false,
      error: controlError(error),
    };
  }
  socket.write(`${JSON.stringify(response)}\n`);
}

function sendControlRequest(
  endpoint: string,
  request: ControlRequestInput,
  options: AgentControlClientOptions,
): Promise<unknown> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const socket = (
      options.connect ??
      ((pathToSocket: string) => createConnection({ path: pathToSocket }))
    )(endpoint);
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for local agent control response"));
    }, options.timeoutMs ?? 5_000);
    let pending = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, ...request })}\n`);
    });
    socket.on("data", (chunk: string) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(
          pending.slice(0, newline),
        ) as ControlResponse;
        if (response.id !== id)
          throw new Error("Mismatched local control response");
        if (!response.ok)
          throw new Error(response.error ?? "Local control request failed");
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

/** Client seam used by the future CLI/Desktop without opening a network port. */
export function createAgentControlClient(
  endpoint: string,
  options: AgentControlClientOptions = {},
): AgentControlClient {
  return {
    async health() {
      return (await sendControlRequest(
        endpoint,
        { method: "health" },
        options,
      )) as AgentHealth;
    },
    async status() {
      return (await sendControlRequest(
        endpoint,
        { method: "status" },
        options,
      )) as AgentStatus;
    },
    async approve(executionId: string) {
      if (!executionId.trim())
        throw new TypeError("executionId must be a nonempty string");
      await sendControlRequest(
        endpoint,
        { method: "approve", executionId },
        options,
      );
    },
    async sync() {
      await sendControlRequest(endpoint, { method: "sync" }, options);
    },
  };
}
