import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGENT_CLIENT_PROTOCOL_VERSION,
  CLIENT_EVENT_TYPES,
  CLIENT_RUNTIME_IDS,
  encodeClientEventBatch,
  encodeClientHello,
  encodeInventoryReport,
  encodePluginSyncAcknowledgement,
  parseClientCommand,
  parseClientEvent,
  parseClientEventBatch,
  parseClientHello,
  parseHubDownlink,
  parseHubEventAcknowledgement,
  parseInventoryReport,
  parsePluginSyncAcknowledgement,
} from "./index.js";
import * as compatibilityWire from "../wire.js";

const agentRunCommand = {
  kind: "agent.run",
  commandId: "command-1",
  executionId: "execution-1",
  taskId: "task-1",
  attempt: 0,
  runtime: "codex",
  payload: { prompt: "Read this" },
} as const;

describe("agent-client protocol export boundary", () => {
  it("parses each valid v2 envelope through the protocol subpath", () => {
    assert.deepEqual(
      parseClientHello({
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
      }),
      {
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
      },
    );
    assert.deepEqual(
      parseClientHello({
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
        name: "MacBook Pro",
      }),
      {
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
        name: "MacBook Pro",
      },
    );
    // A blank name is dropped, not rejected — older strictness stays intact.
    assert.deepEqual(
      parseClientHello({
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
        name: "  ",
      }),
      {
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
      },
    );
    assert.equal(
      parseClientHello({
        type: "client.hello",
        protocolVersion: 2,
        clientId: "client-1",
        nickname: "nope",
      }),
      null,
    );
    assert.deepEqual(
      parseHubDownlink({ type: "task.offer", command: agentRunCommand }),
      {
        type: "task.offer",
        command: agentRunCommand,
      },
    );
    assert.deepEqual(
      parseClientEventBatch({
        type: "event.push",
        events: [
          {
            executionId: "execution-1",
            eventSeq: 3,
            type: "progress",
            payload: { percent: 50 },
            occurredAt: "2026-09-18T00:00:00.000Z",
          },
        ],
      }),
      [
        {
          executionId: "execution-1",
          eventSeq: 3,
          type: "progress",
          payload: { percent: 50 },
          occurredAt: "2026-09-18T00:00:00.000Z",
        },
      ],
    );
    assert.deepEqual(
      parseClientEvent({
        executionId: "execution-1",
        eventSeq: 3,
        type: "progress",
        occurredAt: "2026-09-18T00:00:00.000Z",
      }),
      {
        executionId: "execution-1",
        eventSeq: 3,
        type: "progress",
        occurredAt: "2026-09-18T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      parseHubDownlink({
        type: "plugin.sync",
        revision: "plugins-v3",
        plugins: [
          {
            id: "demo",
            gitUrl: "https://example.test/demo.git",
            enabled: true,
          },
        ],
      }),
      {
        type: "plugin.sync",
        revision: "plugins-v3",
        plugins: [
          {
            id: "demo",
            gitUrl: "https://example.test/demo.git",
            enabled: true,
          },
        ],
      },
    );
  });

  it("rejects invalid v2 envelopes with the established null result", () => {
    const cases: Array<[string, unknown, (value: unknown) => unknown]> = [
      ["unknown message", { type: "unknown.message" }, parseHubDownlink],
      [
        "unknown version",
        { type: "client.hello", protocolVersion: 1, clientId: "client-1" },
        parseClientHello,
      ],
      [
        "malformed event",
        {
          type: "event.push",
          events: [
            {
              executionId: "execution-1",
              eventSeq: -1,
              type: "progress",
              occurredAt: "now",
            },
          ],
        },
        parseClientEventBatch,
      ],
      [
        "malformed command",
        { ...agentRunCommand, executionId: "" },
        parseClientCommand,
      ],
    ];

    for (const [name, value, parse] of cases) {
      assert.equal(parse(value), null, name);
    }
  });

  it("parses a valid inventory report", () => {
    const report = {
      type: "inventory.report",
      reportedAt: "2026-09-19T00:00:00.000Z",
      platforms: [
        { platform: "codex", installed: true, version: "1.2.3" },
        { platform: "zcode", installed: false, version: null, reason: "not configured" },
      ],
      plugins: [
        {
          id: "demo",
          gitUrl: "https://example.com/demo.git",
          ref: "v1",
          enabled: true,
          status: "active",
          resolvedCommit: "a".repeat(40),
          installedAt: "2026-09-19T00:00:00.000Z",
        },
        {
          id: "broken",
          gitUrl: "https://example.com/broken.git",
          enabled: false,
          status: "failed",
          resolvedCommit: "unresolved",
          installedAt: "2026-09-19T00:00:00.000Z",
          lastError: "git clone failed",
        },
      ],
      projects: [{ name: "web" }, { name: "api" }],
    };
    assert.deepEqual(parseInventoryReport(report), report);
  });

  it("rejects invalid inventory reports", () => {
    assert.equal(parseInventoryReport(null), null);
    assert.equal(parseInventoryReport({ type: "inventory.report" }), null);
    assert.equal(
      parseInventoryReport({
        type: "inventory.report",
        reportedAt: "2026-09-19T00:00:00.000Z",
        platforms: [{ platform: "nope", installed: true, version: null }],
        plugins: [],
        projects: [],
      }),
      null,
    );
    // Missing or malformed projects reject: the field is mandatory so a Hub
    // never has to distinguish pre-projects clients by shape sniffing.
    assert.equal(
      parseInventoryReport({
        type: "inventory.report",
        reportedAt: "2026-09-19T00:00:00.000Z",
        platforms: [],
        plugins: [],
      }),
      null,
    );
    assert.equal(
      parseInventoryReport({
        type: "inventory.report",
        reportedAt: "2026-09-19T00:00:00.000Z",
        platforms: [],
        plugins: [],
        projects: [{ name: "" }],
      }),
      null,
    );
    assert.equal(
      parseInventoryReport({
        type: "inventory.report",
        reportedAt: "2026-09-19T00:00:00.000Z",
        platforms: [],
        plugins: [
          {
            id: "x",
            gitUrl: "https://example.com/x.git",
            enabled: true,
            status: "unknown",
            resolvedCommit: "a".repeat(40),
            installedAt: "2026-09-19T00:00:00.000Z",
          },
        ],
      }),
      null,
    );
  });

  it("accepts plugin.sync with inventoryQuery flag and rejects extra keys", () => {
    assert.deepEqual(
      parseHubDownlink({
        type: "plugin.sync",
        revision: "r1",
        plugins: [],
        inventoryQuery: true,
      }),
      { type: "plugin.sync", revision: "r1", plugins: [], inventoryQuery: true },
    );
    assert.equal(
      parseHubDownlink({
        type: "plugin.sync",
        revision: "r1",
        plugins: [],
        inventoryQuery: "yes",
      }),
      null,
    );
  });

  it("round-trips version, execution, ordering, watermarks, and plugin revisions", () => {
    const hello = encodeClientHello("client-1");
    assert.equal(hello.protocolVersion, AGENT_CLIENT_PROTOCOL_VERSION);
    assert.deepEqual(parseClientHello(hello), hello);

    const events = encodeClientEventBatch([
      {
        executionId: "execution-1",
        eventSeq: 3,
        type: "progress",
        occurredAt: "2026-09-18T00:00:00.000Z",
      },
    ]);
    assert.deepEqual(parseClientEventBatch(events), events.events);
    assert.deepEqual(
      parseHubEventAcknowledgement({
        type: "event.ack",
        watermarks: { "execution-1": 3 },
      }),
      { type: "event.ack", watermarks: { "execution-1": 3 } },
    );

    const acknowledgement = encodePluginSyncAcknowledgement({
      type: "plugin.sync.ack",
      revision: "plugins-v3",
      status: "applied",
      plugins: [{ id: "demo", resolvedCommit: "a".repeat(40) }],
    });
    assert.deepEqual(
      parsePluginSyncAcknowledgement(acknowledgement),
      acknowledgement,
    );
  });

  it("keeps the wire compatibility export observably identical", () => {
    const compatibilityExports = {
      AGENT_CLIENT_PROTOCOL_VERSION,
      CLIENT_EVENT_TYPES,
      CLIENT_RUNTIME_IDS,
      encodeClientEventBatch,
      encodeClientHello,
      encodeInventoryReport,
      encodePluginSyncAcknowledgement,
      parseClientCommand,
      parseClientEvent,
      parseClientEventBatch,
      parseClientHello,
      parseHubDownlink,
      parseHubEventAcknowledgement,
      parseInventoryReport,
      parsePluginSyncAcknowledgement,
    };
    assert.deepEqual(
      Object.keys(compatibilityWire).sort(),
      Object.keys(compatibilityExports).sort(),
    );
    for (const [name, value] of Object.entries(compatibilityExports)) {
      assert.equal(
        compatibilityWire[name as keyof typeof compatibilityWire],
        value,
        `${name} must remain the same runtime export`,
      );
    }
  });
});

describe("respond_tool_approval command wire", () => {
  it("parses a valid approval decision with and without reason", () => {
    const base = {
      kind: "respond_tool_approval",
      commandId: "cmd-1",
      executionId: "exec-1",
      requestId: "req-1",
      decision: "deny",
    };
    const parsed = parseClientCommand(base);
    assert.deepEqual(parsed, base);
    assert.deepEqual(parseClientCommand({ ...base, decision: "allow", reason: "ok" }), {
      ...base,
      decision: "allow",
      reason: "ok",
    });
  });

  it("rejects malformed approval decisions", () => {
    const base = {
      kind: "respond_tool_approval",
      commandId: "cmd-1",
      executionId: "exec-1",
      requestId: "req-1",
      decision: "allow",
    };
    assert.equal(parseClientCommand({ ...base, decision: "maybe" }), null);
    assert.equal(parseClientCommand({ ...base, requestId: "" }), null);
    assert.equal(parseClientCommand({ ...base, extra: 1 }), null);
    assert.equal(parseClientCommand({ ...base, reason: 42 }), null);
  });
});
