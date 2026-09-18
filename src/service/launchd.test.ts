import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLaunchAgentPlist, launchAgentPath } from "./launchd.js";

describe("launchd user service", () => {
  it("renders a deterministic per-user agent daemon plist", () => {
    const plist = buildLaunchAgentPlist({
      executable: "/usr/local/bin/allinai-agent",
      configDir: "/Users/a/.allinai/agent",
    });

    assert.match(plist, /<string>\/usr\/local\/bin\/allinai-agent<\/string>/);
    assert.match(plist, /<string>daemon<\/string>/);
    assert.match(plist, /<string>\/Users\/a\/\.allinai\/agent<\/string>/);
    assert.match(plist, /<key>RunAtLoad<\/key>/);
    assert.doesNotMatch(plist, /sudo|LaunchDaemons|root/i);
  });

  it("uses only the current user's LaunchAgents directory", () => {
    assert.equal(
      launchAgentPath("/Users/a"),
      "/Users/a/Library/LaunchAgents/ai.allin.allinai-agent.plist",
    );
  });
});
