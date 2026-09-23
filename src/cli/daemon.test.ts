import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentControlClient } from "../control.js";
import { startToolApprovalHttpBridge } from "../control-http.js";
import type {
  ClientTransport,
  ClientTransportHandlers,
} from "../client/transport.js";
import type {
  InventoryReport,
  PluginSyncAcknowledgement,
} from "../protocol/index.js";
import { createLocalAgentDaemon, type RuntimeProbeResult } from "./commands.js";
import type { PlatformProbe } from "../runtime/index.js";

/**
 * Records every handler registration and uplink report. `connect` never fires
 * the connected handler, so tests drive pluginSync deterministically.
 */
function createRecordingTransport(): ClientTransport & {
  recorded: {
    handlers: ClientTransportHandlers | null;
    pluginSyncAcks: PluginSyncAcknowledgement[];
    inventoryReports: InventoryReport[];
  };
} {
  const recorded = {
    handlers: null as ClientTransportHandlers | null,
    pluginSyncAcks: [] as PluginSyncAcknowledgement[],
    inventoryReports: [] as InventoryReport[],
  };
  return {
    recorded,
    async connect(handlers) {
      recorded.handlers = handlers;
    },
    async push() {
      return {};
    },
    async reportPluginSync(acknowledgement) {
      recorded.pluginSyncAcks.push(acknowledgement);
    },
    async reportInventory(report) {
      recorded.inventoryReports.push(report);
    },
    async close() {},
  };
}

const INVENTORY_PROBE_RESULTS: RuntimeProbeResult[] = [
  { id: "codex", probe: { installed: true, version: null } },
  { id: "claude", probe: { installed: true, version: "4.5.0" } },
  { id: "pi", probe: { installed: true, version: "0.1.2" } },
  {
    id: "zcode",
    probe: {
      installed: false,
      version: null,
      reason: "zcode sdk is not installed",
    },
  },
];

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const INVENTORY_PROBE_REJECTION = new Error(
  "pi sdk is not installed (optional dependency missing)",
);

function probe(id: string, probeResult: PlatformProbe): RuntimeProbeResult {
  return { id, probe: probeResult };
}

describe("local agent daemon composition", () => {
  it("resolves settled() only after the first connection outcome", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-settled-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => "settled-token",
      save: async () => undefined,
      clear: async () => undefined,
    };
    // A transport that records its handlers but never auto-connects: the test
    // decides when the connection settles.
    let fireConnected: (() => Promise<void>) | null = null;
    const transport: ClientTransport = {
      async connect(handlers) {
        fireConnected = handlers.connected;
      },
      async push() {
        return {};
      },
      async close() {},
    };

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
      createTransport: () => transport,
    });
    try {
      assert.deepEqual(await daemon.health(), { status: "degraded" });
      // Not settled yet: the printed status must wait. Assert via a race.
      const early = await Promise.race([
        daemon.settled().then(() => "settled"),
        sleep(100).then(() => "pending"),
      ]);
      // Either it timed out on the 5s cap path (still pending here) or the hub
      // never connected; the observable contract is that health stays degraded.
      assert.equal(early, "pending");
      await fireConnected!();
      await daemon.settled();
      assert.deepEqual(await daemon.health(), { status: "ok" });
    } finally {
      await daemon.close();
    }
  });

  async function sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  let dir = "";
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("acquires one local control socket and remains unpaired without a credential", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
    });
    close = () => daemon.close();

    assert.deepEqual(await daemon.health(), { status: "unpaired" });
    assert.equal(
      (await createAgentControlClient(path.join(dir, "control.sock")).status())
        .state,
      "unpaired",
    );
    await assert.rejects(
      createLocalAgentDaemon({ configDir: dir, credentials }),
      /control socket is already active/,
    );
  });

  it("wires an inventoryProvider that reports installed plugins and probed platforms", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-inventory-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: ["fixture.test"],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => "daemon-inventory-token",
      save: async () => undefined,
      clear: async () => undefined,
    };
    const transport = createRecordingTransport();

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
      probeRuntimes: async () => INVENTORY_PROBE_RESULTS,
      createTransport: () => transport,
    });
    close = () => daemon.close();

    // Drive one real plugin sync so the store holds an InstalledPlugin before
    // the inventory query is answered from local state.
    const handlers = transport.recorded.handlers;
    assert.ok(handlers?.pluginSync, "daemon must register a pluginSync handler");
    await handlers.pluginSync({
      revision: "install-rev-1",
      plugins: [
        {
          id: "smoke-plugin",
          gitUrl: "https://fixture.test/daemon-inventory-plugin.git",
          ref: "refs/heads/main",
          enabled: false,
        },
      ],
      inventoryQuery: false,
    });
    assert.equal(
      transport.recorded.pluginSyncAcks.at(-1)?.status,
      "applied",
      "the plugin sync must apply before the inventory query",
    );
    // Wait for the fire-and-forget proactive post-sync report so the later
    // forced query report below is not asserted against a moving baseline.
    await waitFor(
      () => transport.recorded.inventoryReports.length >= 1,
      "the proactive post-sync inventory report",
    );

    // The transport-level inventoryQuery path must reach the wired provider
    // through observeTransport and produce a full inventory report. The
    // proactive post-sync report (void, throttled) has already landed; the
    // forced query report below is never throttled and must also arrive.
    await handlers.pluginSync({
      revision: "inventory-query-rev-1",
      plugins: [],
      inventoryQuery: true,
    });
    await waitFor(
      () => transport.recorded.inventoryReports.length >= 2,
      "the forced inventory report after the query",
    );

    const reports = transport.recorded.inventoryReports;
    assert.ok(reports.length >= 2);
    // Reports converge: every delivered report carries the same durable
    // platform and plugin snapshot built from local state.
    for (const report of reports) {
      assert.equal(report.type, "inventory.report");
      assert.equal(typeof report.reportedAt, "string");
      assert.equal(report.platforms.length, 4);
      assert.equal(report.plugins.length, 1);
      assert.equal(report.plugins[0]?.id, "smoke-plugin");
    }
    const report = reports.at(-1)!;

    assert.equal(report.platforms.length, 4);
    const zcode = report.platforms.find(
      (platform) => platform.platform === "zcode",
    );
    assert.ok(zcode, "the zcode probe must appear in the platform list");
    assert.equal(zcode.installed, false);
    assert.equal(zcode.reason, "zcode sdk is not installed");
    const claude = report.platforms.find(
      (platform) => platform.platform === "claude",
    );
    assert.ok(claude?.installed);
    assert.equal(claude.version, "4.5.0");

    assert.equal(report.plugins.length, 1);
    assert.equal(report.plugins[0]?.id, "smoke-plugin");
    assert.equal(report.plugins[0]?.status, "blocked");
    assert.equal(report.plugins[0]?.enabled, false);
    assert.equal(report.plugins[0]?.resolvedCommit, "unresolved");
    assert.equal(
      report.plugins[0]?.gitUrl,
      "https://fixture.test/daemon-inventory-plugin.git",
    );
  });

  it("degrades a rejecting platform probe to installed:false and keeps the other platforms", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-probe-fail-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: ["fixture.test"],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => "daemon-probe-fail-token",
      save: async () => undefined,
      clear: async () => undefined,
    };
    const transport = createRecordingTransport();

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
      // One platform's probe rejects (the typical missing optional SDK case);
      // the provider must not turn that into an empty platform list. The cast
      // mirrors the array-construction stage where probe() has already been
      // invoked but not yet awaited.
      probeRuntimes: async () => [
        probe("codex", { installed: true, version: "1.2.3" }),
        probe("claude", { installed: true, version: null }),
        {
          id: "pi",
          probe: Promise.reject(
            INVENTORY_PROBE_REJECTION,
          ) as unknown as PlatformProbe,
        },
      ],
      createTransport: () => transport,
    });
    close = () => daemon.close();

    // Drive a forced inventory query so the report reflects the probe run.
    const handlers = transport.recorded.handlers;
    assert.ok(handlers?.pluginSync, "daemon must register a pluginSync handler");
    await handlers.pluginSync({
      revision: "probe-fail-rev-1",
      plugins: [],
      inventoryQuery: true,
    });
    await waitFor(
      () => transport.recorded.inventoryReports.length >= 1,
      "the forced inventory report after the query",
    );

    const report = transport.recorded.inventoryReports.at(-1)!;
    assert.equal(report.type, "inventory.report");
    assert.equal(
      report.platforms.length,
      3,
      "a single rejecting probe must not empty the platform list",
    );
    const pi = report.platforms.find((platform) => platform.platform === "pi");
    assert.ok(pi, "the failing platform must still be listed");
    assert.equal(pi.installed, false);
    assert.equal(pi.version, null);
    assert.ok(
      pi.reason?.includes(INVENTORY_PROBE_REJECTION.message),
      `the reason must carry the probe error, got: ${pi.reason}`,
    );
    const codex = report.platforms.find(
      (platform) => platform.platform === "codex",
    );
    assert.ok(codex?.installed, "the healthy platform must stay installed");
    assert.equal(codex.version, "1.2.3");
    const claude = report.platforms.find(
      (platform) => platform.platform === "claude",
    );
    assert.ok(claude?.installed);
    assert.equal(claude.version, null);
  });

  it("keeps booting when the tool-approval bridge fails to listen", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-bridge-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };

    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
      // Approval-capable runner shape so the daemon ATTEMPTS the bridge start;
      // the injected starter rejects and boot must survive it.
      createRunner: () =>
        ({
          respondToolApproval: () => {},
          ownerOfToolApproval: () => null,
        }) as never,
      startToolApprovalBridge: async () => {
        throw new Error("EADDRINUSE: port 8787 taken");
      },
    });
    close = () => daemon.close();

    // The bridge failure is non-fatal: the daemon is up and serving control.
    assert.deepEqual(await daemon.health(), { status: "unpaired" });
    assert.equal(
      (await createAgentControlClient(path.join(dir, "control.sock")).status())
        .state,
      "unpaired",
    );
  });

  it("starts the approval bridge for prototype-method runners and replays supervisor decisions", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agentkit-daemon-relay-"));
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        hubBaseUrl: "https://hub.example.test",
        clientId: "test-client",
        maxConcurrentRuns: 1,
        policy: {
          requireRunApproval: false,
          autoPermissions: [],
          allowedGitOrigins: [],
          deniedPluginIds: [],
          allowedWorkspaceRoots: [],
        },
      }),
    );
    const credentials = {
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };

    // The real IsolatedRunnerManager exposes respondToolApproval and
    // ownerOfToolApproval as PROTOTYPE methods. An object-literal fake masks a
    // wrapper built with `{ ...baseRunner }`, so this runner is a small class:
    // the capability gate must survive prototype-only methods.
    const relayed: Array<{
      executionId: string;
      requestId: string;
      decision: "allow" | "deny";
      reason?: string;
    }> = [];
    class PrototypeMethodRunner {
      respondToolApproval(
        executionId: string,
        requestId: string,
        decision: "allow" | "deny",
        reason?: string,
      ): void {
        relayed.push({
          executionId,
          requestId,
          decision,
          ...(reason !== undefined ? { reason } : {}),
        });
      }
      ownerOfToolApproval(requestId: string): string | null {
        return relayed.some((entry) => entry.requestId === requestId)
          ? "exec-1"
          : null;
      }
    }

    // Port 0 keeps the real bridge off any fixed endpoint; the injected
    // starter only records that the daemon actually attempted the start.
    let bridgeStartAttempts = 0;
    const daemon = await createLocalAgentDaemon({
      configDir: dir,
      credentials,
      createRunner: () => new PrototypeMethodRunner() as never,
      startToolApprovalBridge: async (bridgeOptions) => {
        bridgeStartAttempts += 1;
        return startToolApprovalHttpBridge({
          ...bridgeOptions,
          port: 0,
        });
      },
    });
    close = () => daemon.close();

    // (i) The capability gate fires on prototype methods: the bridge started.
    assert.equal(bridgeStartAttempts, 1, "bridge must start for the runner");
    const bridgeUrl = daemon.toolApprovalBridgeUrl;
    assert.ok(
      bridgeUrl?.startsWith("http://127.0.0.1:"),
      `bridge URL must be a loopback HTTP endpoint, got: ${bridgeUrl}`,
    );

    // (ii) A supervisor-level decision (the console/control path) must reach
    // the WRAPPED runner — recorded into the decision map AND forwarded to the
    // base runner — so a subsequent hook POST replays it instead of denying
    // with unknown_request_id.
    const client = createAgentControlClient(path.join(dir, "control.sock"));
    assert.ok(
      client.respondToolApproval,
      "control client must expose respondToolApproval",
    );
    await client.respondToolApproval(
      "exec-1",
      "req-prototype-1",
      "allow",
      "human said yes",
    );

    const replay = await fetch(`${bridgeUrl}/control/tool-approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "codex",
        payload: { requestId: "req-prototype-1", tool_name: "Bash" },
      }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()) as Record<string, unknown>, {
      decision: "allow",
      reason: "human said yes",
    });
    // The decision was also forwarded to the base runner, not swallowed.
    assert.deepEqual(relayed, [
      {
        executionId: "exec-1",
        requestId: "req-prototype-1",
        decision: "allow",
        reason: "human said yes",
      },
    ]);
  });
});
