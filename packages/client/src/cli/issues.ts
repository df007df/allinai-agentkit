/**
 * Issue CLI: the agent-facing surface for the issue domain. Skills teach
 * agents to call these commands; they read the local config (hubBaseUrl,
 * clientId) plus the client token from the credential store and talk to the
 * hub's `/_agentkit/api/v1` REST surface. No daemon required — the CLI is
 * self-sufficient on any machine the package is installed on.
 */

import type { CredentialStore } from "../credentials.js";
import { loadAgentConfig } from "../config.js";
import type { AgentPaths } from "../paths.js";

export type IssueApiResult = Record<string, unknown>;

export type IssueApiClient = {
  request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<IssueApiResult>;
};

export function createIssueApiClient(input: {
  paths: AgentPaths;
  credentials: CredentialStore;
  fetchImpl?: typeof fetch;
}): Promise<IssueApiClient> {
  const config = loadAgentConfig(input.paths);
  const fetchImpl = input.fetchImpl ?? fetch;
  return input.credentials.load(config.clientId).then((token) => {
    if (!token) {
      throw new Error(
        `No token for client ${config.clientId}; run allinai-agentkit login first`,
      );
    }
    const base = `${config.hubBaseUrl}/_agentkit/api/v1`;
    return {
      async request(method, path, body) {
        const response = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const payload = (await response.json().catch(() => ({}))) as IssueApiResult;
        if (!response.ok) {
          const message =
            typeof payload.error === "string" ? payload.error : response.statusText;
          throw new Error(`issue API ${method} ${path} failed: ${message}`);
        }
        return payload;
      },
    };
  });
}

/** Human-readable rendering used by `issue show` without --json. */
export function renderIssueDetail(
  issue: {
    issueKey: string;
    title: string;
    status: string;
    priority: string;
    body?: string;
  },
  comments: Array<{
    authorActorType: string;
    authorActorId: string;
    body: string;
    createdAt: string;
  }>,
): string[] {
  const lines = [
    `${issue.issueKey}  ${issue.title}`,
    `状态: ${issue.status}  优先级: ${issue.priority}`,
  ];
  if (issue.body) lines.push(`正文: ${issue.body}`);
  if (comments.length > 0) {
    lines.push("评论:");
    for (const comment of comments) {
      lines.push(
        `  [${comment.createdAt}] ${comment.authorActorType}:${comment.authorActorId}: ${comment.body}`,
      );
    }
  }
  return lines;
}
