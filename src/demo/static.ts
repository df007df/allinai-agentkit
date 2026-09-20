import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATIC_PATH_PREFIX } from "../routes.js";

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

/**
 * Serves the demo pages under the reserved agentkit prefix only. The site
 * root belongs to the embedding host: a bare visit is redirected to the
 * console, while every other host-owned path stays untouched (404 here).
 */
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
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.writeHead(302, { location: `${STATIC_PATH_PREFIX}/` });
      response.end();
      return;
    }
    if (!url.pathname.startsWith(`${STATIC_PATH_PREFIX}/`)) {
      // Not ours: the host site owns this namespace.
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const stripped = url.pathname.slice(`${STATIC_PATH_PREFIX}/`.length);
    // Directory-style visits ("`/_agentkit/`" or "`/_agentkit/sub/`") map to
    // the directory's index document, matching conventional static hosting.
    const relative = url.pathname === `${STATIC_PATH_PREFIX}/login`
      ? "login.html"
      : stripped === "" || stripped.endsWith("/")
        ? `${stripped}index.html`
        : stripped;
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
