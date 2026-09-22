import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, it, test } from "node:test";
import { createStaticHandler, resolveWebRoot } from "./static.js";

interface GetResult {
  res: http.ServerResponse;
  body: string;
}

async function get(
  handler: http.RequestListener,
  target: string,
): Promise<GetResult> {
  let serverRes: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    serverRes = res;
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<GetResult>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: target }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ res: serverRes as http.ServerResponse, body: Buffer.concat(chunks).toString("utf8") }),
        );
      });
      req.on("error", reject);
    });
  } finally {
    server.close();
  }
}

// Same shape as the request helper in src/demo/static.test.ts so ported
// assertions read identically; built on `get` so every test goes through
// one transport.
async function request(
  handler: http.RequestListener,
  target: string,
): Promise<Response> {
  const { res, body } = await get(handler, target);
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
  }
  return new Response(body, { status: res.statusCode, headers });
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

test("serves extensionless route as sibling html", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "console-static-"));
  await writeFile(path.join(root, "executions.html"), "<html>e</html>");
  const handler = createStaticHandler(root);
  const { res, body } = await get(handler, "/executions");
  assert.equal(res.statusCode, 200);
  assert.match(String(res.getHeader("content-type")), /text\/html/);
  assert.equal(body, "<html>e</html>");
});

test("serves directory index for extensionless route", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "console-static-"));
  await mkdir(path.join(root, "app"), { recursive: true });
  await writeFile(path.join(root, "app", "index.html"), "<html>i</html>");
  const handler = createStaticHandler(root);
  const { res, body } = await get(handler, "/app");
  assert.equal(res.statusCode, 200);
  assert.equal(body, "<html>i</html>");
});
