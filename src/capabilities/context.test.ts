import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCapabilityContext, type LocalContextSource } from "./context.js";

describe("shell capability context", () => {
  it("does not leak token or ambient environment into context", () => {
    const source: LocalContextSource = {
      execution: {
        executionId: "execution-1",
        taskId: "task-1",
        attempt: 2,
        runtime: "codex",
        token: "secret-token",
        hubCredential: "hub-secret",
      },
      workspace: { path: "/workspace/demo", token: "workspace-secret" },
      projectConfig: {
        label: "Demo",
        nested: {
          retain: true,
          apiKey: "project-secret",
          bearerToken: "nested-bearer-value",
          sessionCookie: "nested-cookie-value",
        },
        token: "config-secret",
        session: "session-value",
        cookie: "cookie-value",
        bearer: "bearer-value",
        accessKey: "access-key-value",
      },
      environment: { PATH: "/private/bin", ACCESS_TOKEN: "ambient-secret" },
    };

    const context = buildCapabilityContext(
      ["execution", "workspace", "projectConfig"],
      source,
    );

    assert.deepEqual(context, {
      execution: {
        executionId: "execution-1",
        taskId: "task-1",
        attempt: 2,
        runtime: "codex",
      },
      workspace: { path: "/workspace/demo" },
      projectConfig: { label: "Demo", nested: { retain: true } },
    });
    assert.equal("token" in context, false);
    assert.doesNotMatch(
      JSON.stringify(context),
      /secret|private\/bin|session-value|cookie-value|bearer-value|access-key-value/i,
    );
  });

  it("returns a newly-built serializable context limited to requested keys", () => {
    const source: LocalContextSource = {
      execution: { executionId: "execution-1", taskId: "task-1", attempt: 1 },
      workspace: { path: "/workspace/demo" },
      projectConfig: { nested: { retain: true } },
    };

    const context = buildCapabilityContext(["projectConfig"], source);
    (source.projectConfig!.nested as { retain: boolean }).retain = false;

    assert.deepEqual(context, { projectConfig: { nested: { retain: true } } });
    assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
    assert.equal("execution" in context, false);
    assert.equal("workspace" in context, false);
  });
});
