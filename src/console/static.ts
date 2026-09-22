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

/** src/console/*.ts 与 dist/console/*.js 到包根均为两级，两者解析到同一 web/。 */
export function resolveWebRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web",
  );
}

/** Read a candidate file, or null when it does not exist / is a directory. */
async function tryRead(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch {
    // Missing files, directories (EISDIR) and unreadable paths all fall
    // through to the next candidate — or to the shared 404.
    return null;
  }
}

/**
 * Serves the console assets. Paths resolve against the web root with
 * extensionless fallbacks (Next-style static export layout): `/x` tries
 * `x`, `x.html`, then `x/index.html`; a trailing slash goes straight to
 * `index.html`. The reserved agentkit prefix is accepted as an alias and
 * stripped, so `/_agentkit/login` resolves to `login.html` exactly like
 * the bare `/login` does. The site root belongs to the embedding host: a
 * bare visit is redirected to the console, and anything that does not
 * resolve to a known asset here stays untouched (404).
 */
export function createStaticHandler(
  webRoot: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  const root = path.resolve(webRoot);
  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const url = new URL(request.url ?? "/", "http://console.invalid");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      response.statusCode = 302;
      response.setHeader("location", `${STATIC_PATH_PREFIX}/`);
      response.end();
      return;
    }
    const relative = url.pathname.startsWith(`${STATIC_PATH_PREFIX}/`)
      ? url.pathname.slice(STATIC_PATH_PREFIX.length)
      : url.pathname;
    // Directory-style visits ("`/app/`") map to the directory's index
    // document; bare extensionless paths try the literal file, its `.html`
    // sibling, then the directory index — matching conventional static
    // hosting of Next-style exports.
    const candidates = relative.endsWith("/")
      ? [path.join(root, relative, "index.html")]
      : [
          path.join(root, relative),
          `${path.join(root, relative)}.html`,
          path.join(root, relative, "index.html"),
        ];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        break; // traversal attempt: straight to the shared 404
      }
      const type = CONTENT_TYPES[path.extname(resolved)];
      if (!type) {
        continue; // unknown extension: not an asset we serve
      }
      const body = await tryRead(resolved);
      if (body !== null) {
        response.statusCode = 200;
        response.setHeader("content-type", type);
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "not_found" }));
  };
}
