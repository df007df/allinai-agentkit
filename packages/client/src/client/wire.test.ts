import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeClientHello,
  encodeClientEventBatch,
  parseClientHello,
  parseClientCommand,
  parseClientEventBatch,
  parseHubDownlink,
  parseHubEventAcknowledgement,
  encodePluginSyncAcknowledgement,
  parsePluginSyncAcknowledgement,
} from "./wire.js";

describe("client wire protocol", () => {
  it("rejects agent.run without a nonempty executionId", () => {
    assert.equal(
      parseClientCommand({
        kind: "agent.run",
        commandId: "c1",
        executionId: "",
        taskId: "t",
        attempt: 1,
        runtime: "codex",
        payload: {},
      }),
      null,
    );
  });

  it("accepts a typed capability invocation without a shell command field", () => {
    const command = parseClientCommand({
      kind: "capability.invoke",
      commandId: "c1",
      executionId: "e1",
      taskId: "t1",
      attempt: 1,
      capabilityId: "acme.publish",
      input: { branch: "main" },
    });

    assert.equal(command?.kind, "capability.invoke");
  });

  it("rejects arbitrary shell controls from capability invocations", () => {
    for (const unsafeField of ["command", "argv", "shell"]) {
      assert.equal(
        parseClientCommand({
          kind: "capability.invoke",
          commandId: "c1",
          executionId: "e1",
          taskId: "t1",
          attempt: 1,
          capabilityId: "acme.publish",
          input: { [unsafeField]: "echo unsafe" },
        }),
        null,
      );
    }
  });

  it("rejects shell controls nested in capability input objects and arrays", () => {
    for (const input of [
      { options: { command: "echo unsafe" } },
      { steps: [{ argv: ["echo", "unsafe"] }] },
      { steps: [{ shell: "echo unsafe" }] },
    ]) {
      assert.equal(
        parseClientCommand({
          kind: "capability.invoke",
          commandId: "c1",
          executionId: "e1",
          taskId: "t1",
          attempt: 1,
          capabilityId: "acme.publish",
          input,
        }),
        null,
      );
    }
  });

  it("parses only valid event batches and serializes them as event.push", () => {
    const batch = parseClientEventBatch({
      type: "event.push",
      events: [
        {
          executionId: "e1",
          eventSeq: 0,
          type: "received",
          payload: { source: "hub" },
          occurredAt: "2026-09-18T00:00:00.000Z",
        },
      ],
    });

    assert.deepEqual(batch, [
      {
        executionId: "e1",
        eventSeq: 0,
        type: "received",
        payload: { source: "hub" },
        occurredAt: "2026-09-18T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(encodeClientEventBatch(batch ?? []), {
      type: "event.push",
      events: batch,
    });
    assert.equal(
      parseClientEventBatch({
        type: "event.push",
        events: [
          {
            executionId: "e1",
            eventSeq: -1,
            type: "received",
            occurredAt: "now",
          },
        ],
      }),
      null,
    );
  });

  it("accepts only a current-version client hello", () => {
    assert.deepEqual(encodeClientHello("client-a"), {
      type: "client.hello",
      protocolVersion: 2,
      clientId: "client-a",
    });
    assert.equal(
      parseClientHello({
        type: "client.hello",
        protocolVersion: 1,
        clientId: "client-a",
      }),
      null,
    );
  });

  it("parses only typed v2 downlinks and acknowledgement watermarks", () => {
    const offer = parseHubDownlink({
      type: "task.offer",
      command: {
        kind: "agent.run",
        commandId: "c1",
        executionId: "e1",
        taskId: "t1",
        attempt: 1,
        runtime: "codex",
        payload: {},
      },
    });
    assert.equal(offer?.type, "task.offer");
    assert.deepEqual(
      parseHubEventAcknowledgement({
        type: "event.ack",
        watermarks: { e1: 2 },
      }),
      { type: "event.ack", watermarks: { e1: 2 } },
    );
    assert.equal(parseHubDownlink({ type: "unrecognized.message" }), null);
    assert.equal(
      parseHubEventAcknowledgement({
        type: "event.ack",
        watermarks: { e1: -1 },
      }),
      null,
    );
  });

  it("strictly encodes plugin desired-state acknowledgements without a task pluginSet", () => {
    const acknowledgement = encodePluginSyncAcknowledgement({
      type: "plugin.sync.ack",
      revision: "plugins-v1",
      status: "failed",
      plugins: [{ id: "demo", resolvedCommit: "a".repeat(40) }],
      error: { code: "plugin_sync_failed", message: "manifest is invalid" },
    });

    assert.equal(acknowledgement.plugins[0]?.resolvedCommit, "a".repeat(40));
    assert.deepEqual(
      parsePluginSyncAcknowledgement({
        ...acknowledgement,
        pluginSet: ["must-not-be-accepted"],
      }),
      null,
    );
    assert.deepEqual(
      parsePluginSyncAcknowledgement({
        ...acknowledgement,
        status: "failed",
      }),
      acknowledgement,
    );
  });
});
