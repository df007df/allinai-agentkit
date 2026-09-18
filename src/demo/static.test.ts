import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createStaticHandler, resolveWebRoot } from "./static.js";

async function request(
  handler: http.RequestListener,
  path: string,
): Promise<http.IncomingMessage> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
  });
  server.close();
  return response as unknown as http.IncomingMessage;
}

describe("static handler", () => {
  it("serves index.html for / with html content type", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(handler, "/");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/html; charset=utf-8$/,
    );
    const body = await response.text();
    assert.match(body, /allinai-agentkit/);
  });

  it("serves nested assets with mapped content types", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(handler, "/app.js");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/javascript; charset=utf-8$/,
    );
  });

  it("rejects path traversal and unknown paths with 404", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    assert.equal((await request(handler, "/../package.json")).status, 404);
    assert.equal((await request(handler, "/missing.css")).status, 404);
  });
});
