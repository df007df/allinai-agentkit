import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSystemdUserUnit,
  installSystemdUserService,
  systemdUserUnitPath,
} from "./systemd.js";

describe("systemd user service", () => {
  it("renders a per-user unit with a fixed daemon invocation", () => {
    const unit = buildSystemdUserUnit({
      executable: "/usr/local/bin/allinai-agent",
      configDir: "/home/a/.allinai/agent",
    });

    assert.match(unit, /^\[Unit\]/m);
    assert.match(
      unit,
      /ExecStart=\/usr\/local\/bin\/allinai-agent daemon --config-dir \/home\/a\/\.allinai\/agent/m,
    );
    assert.match(unit, /WantedBy=default\.target/m);
    assert.doesNotMatch(unit, /sudo|system\/|root/i);
  });

  it("uses only the current user's systemd unit directory", () => {
    assert.equal(
      systemdUserUnitPath("/home/a"),
      "/home/a/.config/systemd/user/allinai-agent.service",
    );
  });

  it("refuses a root-owned user-service installation", async () => {
    await assert.rejects(
      installSystemdUserService({
        executable: "/usr/local/bin/allinai-agent",
        configDir: "/root/.allinai/agent",
        homeDir: "/root",
        uid: 0,
        fileSystem: {
          mkdir: async () => undefined,
          writeFile: async () => undefined,
          unlink: async () => undefined,
        },
        execute: async () => undefined,
      }),
      /non-root user/,
    );
  });
});
