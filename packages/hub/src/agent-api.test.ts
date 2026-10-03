import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import {
  AGENT_API_NAMESPACE,
  createAgentApiRouter,
  type AgentApiIdentity,
} from "./agent-api.js";

type Principal = { user: string };

const identityOf = (clientId: string): AgentApiIdentity<Principal> => ({
  principal: { user: "demo-user" },
  clientId,
});

const servers: http.Server[] = [];

function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    servers.push(server);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("no address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("agent api router", () => {
  it.afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  it("mounts declared routes under the reserved namespace with token identity", async () => {
    const router = createAgentApiRouter<Principal>({
      authenticate: (token) => (token === "good" ? identityOf("agent-1") : null),
      routes: [
        {
          method: "GET",
          path: "/whoami",
          handler: ({ identity, response }) => {
            response.end(JSON.stringify(identity));
          },
        },
      ],
    });
    const base = await startServer((request, response) => {
      void router(request, response).then((handled) => {
        if (!handled) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "host_route" }));
        }
      });
    });
    const authorized = await fetch(`${base}${AGENT_API_NAMESPACE}/whoami`, {
      headers: { authorization: "Bearer good" },
    });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), {
      principal: { user: "demo-user" },
      clientId: "agent-1",
    });

    const unauthorized = await fetch(`${base}${AGENT_API_NAMESPACE}/whoami`);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });

    // Namespace-external requests are untouched: the host owns them.
    const foreign = await fetch(`${base}/whoami`);
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), { error: "host_route" });
  });

  it("matches :params, parses JSON bodies, and 404s unknown routes", async () => {
    const router = createAgentApiRouter<Principal>({
      authenticate: (token) => (token === "good" ? identityOf("agent-1") : null),
      routes: [
        {
          method: "POST",
          path: "/projects/:projectId/notes/:noteId",
          handler: ({ params, body, response }) => {
            response.end(JSON.stringify({ params, body }));
          },
        },
      ],
    });
    const base = await startServer((request, response) => {
      void router(request, response);
    });
    const response = await fetch(
      `${base}${AGENT_API_NAMESPACE}/projects/web/notes/n%201`,
      {
        method: "POST",
        headers: { authorization: "Bearer good", "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      params: { projectId: "web", noteId: "n 1" },
      body: { text: "hello" },
    });

    const missing = await fetch(`${base}${AGENT_API_NAMESPACE}/projects/web`, {
      method: "POST",
      headers: { authorization: "Bearer good" },
    });
    assert.equal(missing.status, 404);

    const wrongMethod = await fetch(`${base}${AGENT_API_NAMESPACE}/projects/web/notes/1`);
    assert.equal(wrongMethod.status, 404);
  });

  it("rejects routes touching reserved segments at construction time", () => {
    assert.throws(
      () =>
        createAgentApiRouter<Principal>({
          authenticate: () => null,
          routes: [
            { method: "GET", path: "/hub/v2", handler: () => {} },
          ],
        }),
      /reserved segment "hub"/,
    );
    assert.throws(
      () =>
        createAgentApiRouter<Principal>({
          authenticate: () => null,
          routes: [
            { method: "GET", path: "/deep/login/x", handler: () => {} },
          ],
        }),
      /reserved segment "login"/,
    );
  });

  it("rejects malformed route paths at construction time", () => {
    const routes = (path: string) => [
      { method: "GET" as const, path, handler: () => {} },
    ];
    const build = (path: string) =>
      createAgentApiRouter<Principal>({
        authenticate: () => null,
        routes: routes(path),
      });
    assert.throws(() => build("tasks"), /absolute/);
    assert.throws(() => build("/tasks/"), /absolute/);
    assert.throws(() => build("/tasks//notes"), /empty segment/);
    assert.throws(() => build("/tasks/:/notes"), /unnamed parameter/);
  });
});
