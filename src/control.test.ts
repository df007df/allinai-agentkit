import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createAgentControlClient,
  startAgentControlServer,
} from "./control.js";

describe("agent control endpoint", () => {
  let dir = "";
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    const close = stop;
    stop = undefined;
    await close?.();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves health, status and approval through a Unix socket only", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-control-"));
    const socketPath = path.join(dir, "control.sock");
    const approvals: string[] = [];
    const server = await startAgentControlServer({
      socketPath,
      control: {
        health: () => ({ status: "ok" }),
        status: () => ({ state: "connected", pendingApprovals: ["e-1"] }),
        approve: async (executionId) => {
          approvals.push(executionId);
        },
      },
    });
    stop = () => server.close();
    const client = createAgentControlClient(socketPath);

    assert.deepEqual(await client.health(), { status: "ok" });
    assert.deepEqual(await client.status(), {
      state: "connected",
      pendingApprovals: ["e-1"],
    });
    await client.approve("e-1");
    assert.deepEqual(approvals, ["e-1"]);
  });

  it("does not unlink a non-socket path while handling a stale endpoint", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-control-"));
    const socketPath = path.join(dir, "control.sock");
    writeFileSync(socketPath, "keep me");

    await assert.rejects(
      startAgentControlServer({
        socketPath,
        control: {
          health: () => ({ status: "ok" }),
          status: () => ({ state: "connected" }),
          approve: async () => undefined,
        },
      }),
      /Refusing to remove non-socket control path/,
    );
    assert.equal(readFileSync(socketPath, "utf8"), "keep me");
  });

  it("returns the actual approval error after a parsed request", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-control-"));
    const socketPath = path.join(dir, "control.sock");
    const server = await startAgentControlServer({
      socketPath,
      control: {
        health: () => ({ status: "ok" }),
        status: () => ({ state: "connected" }),
        approve: async () => {
          throw new Error("approval denied");
        },
      },
    });
    stop = () => server.close();

    await assert.rejects(
      createAgentControlClient(socketPath).approve("e-denied"),
      /approval denied/,
    );
  });

  it("allows the local CLI to request a durable sync without accepting a task", async () => {
    if (process.platform === "win32") return;
    dir = mkdtempSync(path.join(tmpdir(), "allinai-agent-control-"));
    const socketPath = path.join(dir, "control.sock");
    let syncs = 0;
    const server = await startAgentControlServer({
      socketPath,
      control: {
        health: () => ({ status: "ok" }),
        status: () => ({ state: "connected" }),
        approve: async () => undefined,
        sync: async () => {
          syncs += 1;
        },
      },
    });
    stop = () => server.close();

    await createAgentControlClient(socketPath).sync?.();
    assert.equal(syncs, 1);
  });
});
