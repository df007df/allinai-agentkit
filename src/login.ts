import { randomUUID } from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { CredentialStore } from "./credentials.js";

export type LoginFlowOptions = {
  hubBaseUrl: string;
  clientId: string;
  credentials: CredentialStore;
  saveConfig: (input: { hubBaseUrl: string; clientId: string }) => Promise<void>;
  open?: (url: string) => Promise<void>;
  onAuthorizeUrl?: (url: string) => void;
  timeoutMs?: number;
};

export type LoginFlowResult = {
  token: string;
  clientId: string;
  hubBaseUrl: string;
};

/** Best-effort system browser opener; callers print the URL as fallback. */
export async function defaultOpenBrowser(url: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open"
    : platform === "win32" ? "rundll32"
    : "xdg-open";
  const args = platform === "win32"
    ? ["url.dll,FileProtocolHandler", url]
    : [url];
  await new Promise<void>((resolve) => {
    execFile(command, args, () => resolve());
  });
}

type CallbackOutcome =
  | { ok: true; token: string }
  | { ok: false; error: string };

export async function runLoginFlow(
  options: LoginFlowOptions,
): Promise<LoginFlowResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const state = randomUUID();
  const server = http.createServer();
  let outcome: CallbackOutcome | null = null;
  // 闭包内赋值不参与控制流收窄，经函数读取以保留联合类型。
  const currentOutcome = (): CallbackOutcome | null => outcome;

  server.on(
    "request",
    (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        response.writeHead(404);
        response.end();
        return;
      }
      const error = url.searchParams.get("error");
      const token = url.searchParams.get("token");
      const callbackState = url.searchParams.get("state");
      if (error) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body>授权被拒绝，可关闭此页返回终端。</body></html>");
        outcome = { ok: false, error };
        return;
      }
      if (!token || callbackState !== state) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<html><body>state 校验失败，请重试 login。</body></html>");
        outcome = { ok: false, error: "state_mismatch" };
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body>授权成功，可关闭此页返回终端。</body></html>");
      outcome = { ok: true, token };
    },
  );

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("login callback server failed to listen");
  }
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const authorizeUrl = `${options.hubBaseUrl}/login?client_id=${encodeURIComponent(
    options.clientId,
  )}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

  try {
    options.onAuthorizeUrl?.(authorizeUrl);
    const open = options.open ?? defaultOpenBrowser;
    await open(authorizeUrl);

    const deadline = Date.now() + timeoutMs;
    while (!outcome) {
      if (Date.now() > deadline) {
        throw new Error(`login timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const settled = currentOutcome();
    if (!settled) {
      throw new Error("login ended without an outcome");
    }
    if (!settled.ok) {
      throw new Error(`authorization failed: ${settled.error}`);
    }
    await options.credentials.save(options.clientId, settled.token);
    await options.saveConfig({
      hubBaseUrl: options.hubBaseUrl,
      clientId: options.clientId,
    });
    return {
      token: settled.token,
      clientId: options.clientId,
      hubBaseUrl: options.hubBaseUrl,
    };
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}
