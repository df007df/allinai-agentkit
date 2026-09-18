import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** src/demo/*.ts 与 dist/demo/*.js 到包根均为两级，两者解析到同一 web/。 */
export function resolveWebRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web",
  );
}

export function createStaticHandler(
  webRoot: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  const root = path.resolve(webRoot);
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://demo.invalid");
    const relative =
      url.pathname === "/"
        ? "index.html"
        : url.pathname === "/login"
          ? "login.html"
          : url.pathname.slice(1);
    const resolved = path.resolve(root, `./${relative}`);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const type = CONTENT_TYPES[path.extname(resolved)];
    if (!type) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const body = await readFile(resolved);
      response.writeHead(200, { "content-type": type });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    }
  };
}
