import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createStaticHandler, resolveWebRoot } from "./static.js";

async function request(
  handler: http.RequestListener,
  path: string,
): Promise<Response> {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: "manual",
  });
  server.close();
  return response;
}

describe("static handler", () => {
  it("redirects the host-owned root to the agentkit console", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(handler, "/");
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/_agentkit/");
    const indexed = await request(handler, "/index.html");
    assert.equal(indexed.status, 302);
    assert.equal(indexed.headers.get("location"), "/_agentkit/");
  });

  it("serves the console page under the agentkit prefix", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(handler, "/_agentkit/");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/html; charset=utf-8$/,
    );
    const body = await response.text();
    assert.match(body, /allinai-agentkit/);
  });

  it("serves the login page at the reserved login path", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(
      handler,
      "/_agentkit/login?client_id=c&state=s",
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /授权接入请求/);
  });

  it("serves nested assets with mapped content types under the prefix", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const response = await request(handler, "/_agentkit/app.js");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/javascript; charset=utf-8$/,
    );
  });

  it("leaves non-agentkit paths to the host site with 404", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    assert.equal((await request(handler, "/about")).status, 404);
    assert.equal((await request(handler, "/api/site/things")).status, 404);
  });

  it("rejects path traversal and unknown agentkit paths with 404", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    assert.equal(
      (await request(handler, "/_agentkit/../package.json")).status,
      404,
    );
    assert.equal((await request(handler, "/_agentkit/missing.css")).status, 404);
  });
});

describe("demo console page content", () => {
  it("serves the console-only demo page and its script", async () => {
    const handler = createStaticHandler(resolveWebRoot());
    const page = await request(handler, "/_agentkit/");
    const body = await page.text();
    assert.match(body, /Demo 控制台/);
    assert.match(body, /协议事件时间线/);
    assert.match(body, /df007df\.github\.io\/allinai-agentkit/);
    // 介绍内容只保留在 GitHub Pages 官网，本地 demo 页不再携带。
    assert.doesNotMatch(body, /独立持久/);
    const script = await request(handler, "/_agentkit/app.js");
    assert.match(await script.text(), /EventSource/);
  });
});
