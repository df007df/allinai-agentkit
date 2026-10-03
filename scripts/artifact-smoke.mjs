// Copied into a clean Hub consumer by verify-package-artifact.mjs. All imports
// below resolve the installed tarballs, never the development workspace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startWebHost } from "@allin-ai/agentkit-hub/web";
import { CONSOLE_PRINCIPAL } from "@allin-ai/agentkit-hub/console";

const clientRoot = process.argv[2];
const client = await import(pathToFileURL(path.join(clientRoot, "dist/client/src/index.js")).href);
const clientHome = path.resolve("client-state");
mkdirSync(clientHome, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = async (condition) => {
  const end = Date.now() + 10_000;
  while (!condition() && Date.now() < end) await sleep(10);
  assert.ok(condition(), "installed packages did not complete the expected roundtrip");
};

// Exercise the binary's default dynamic Web import as well as the SDK below.
async function verifyHubCli(bin, label) {
  const hubCli = spawn(process.execPath, [bin,
    "web", "--port", "0", "--config-dir", path.resolve(label + "-state")], { stdio: ["ignore", "pipe", "pipe"] });
  let cliOutput = "";
  let cliError = "";
  let cliUrl;
  hubCli.stdout.on("data", (data) => {
    cliOutput += data.toString();
    for (const line of cliOutput.split("\n")) {
      try { cliUrl ??= JSON.parse(line).consoleUrl; } catch { /* partial output */ }
    }
  });
  hubCli.stderr.on("data", (data) => { cliError += data.toString(); });
  const cliExit = new Promise((resolve, reject) => {
    hubCli.once("error", reject);
    hubCli.once("exit", (code) => resolve(code));
  });
  try {
    await deadline(() => Boolean(cliUrl));
    assert.equal((await fetch(cliUrl)).status, 200);
  } finally {
    if (hubCli.exitCode === null) hubCli.kill("SIGTERM");
    assert.equal(await cliExit, 0, cliError);
  }
  console.log(`Verified ${label} Hub CLI startup and clean shutdown.`);
}
await verifyHubCli(path.resolve("node_modules/@allin-ai/agentkit-hub/bin/allinai-agentkit-hub"), "installed");
if (process.argv[3]) await verifyHubCli(process.argv[3], "local-compiled");

const site = await startWebHost({ port: 0, dev: false, configDir: path.resolve("hub-state") });
let transport;
let login;
try {
  const page = await fetch(site.url, { signal: AbortSignal.timeout(10_000) });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /allinai-agentkit Console/);
  const script = html.match(/src="([^\"]*\/_next\/static\/[^\"]+)"/);
  assert.ok(script, "production page must reference a compiled client bundle");
  assert.equal((await fetch(new URL(script[1], site.url))).status, 200);
  assert.equal((await fetch(`${site.url}/_agentkit/login?client_id=artifact-client`)).status, 200);
  assert.equal((await fetch(`${site.url}/manifest.webmanifest`)).status, 200);

  login = spawn(process.execPath, [path.join(clientRoot, "bin/allinai-agentkit"), "login", "--hub", site.url,
    "--client", "artifact-client", "--config-dir", clientHome, "--no-browser"], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  let authorizeUrl;
  login.stdout.on("data", (data) => {
    output += data.toString();
    for (const line of output.split("\n")) {
      try { authorizeUrl ??= JSON.parse(line).authorizeUrl; } catch { /* partial output */ }
    }
  });
  login.stderr.on("data", (data) => { errorOutput += data.toString(); });
  const exited = new Promise((resolve, reject) => {
    login.once("error", reject);
    login.once("exit", (code) => resolve(code));
  });
  await deadline(() => Boolean(authorizeUrl));
  const authorize = new URL(authorizeUrl);
  const approved = await fetch(`${site.url}/_agentkit/login/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "artifact-client", state: authorize.searchParams.get("state"),
      redirectUri: authorize.searchParams.get("redirect_uri") }),
  });
  assert.equal(approved.status, 200);
  const { redirectUrl } = await approved.json();
  assert.equal((await fetch(redirectUrl)).status, 200);
  assert.equal(await exited, 0, errorOutput);
  assert.match(output, /"loggedIn":true/);
  const paths = client.resolveAgentPathsAt(clientHome);
  const token = await client.createCredentialStore({ paths }).load("artifact-client");
  assert.ok(token, "Client login did not persist its token");
  assert.equal(client.loadAgentConfig(paths).hubBaseUrl, site.url);

  let command;
  transport = new client.WsClientTransport({ hubBaseUrl: site.url, token, clientId: "artifact-client" });
  await transport.connect({ command: async (value) => { command = value; }, connected: async () => {} });
  await deadline(() => site.runtime.state.hasClient("artifact-client"));
  const offered = { kind: "agent.run", commandId: "artifact-command", executionId: "artifact-execution",
    taskId: "artifact-task", attempt: 1, runtime: "pi", payload: { prompt: "package roundtrip" } };
  await site.runtime.hub.offer({ principal: CONSOLE_PRINCIPAL, targetClientId: "artifact-client", command: offered });
  await deadline(() => Boolean(command));
  assert.deepEqual(command, offered);
  const watermarks = await transport.push([
    { executionId: offered.executionId, eventSeq: 1, type: "received", occurredAt: new Date().toISOString() },
    { executionId: offered.executionId, eventSeq: 2, type: "done", occurredAt: new Date().toISOString() },
  ]);
  assert.deepEqual(watermarks, { "artifact-execution": 2 });
  await deadline(() => site.runtime.state.snapshot().events.some((event) => event.type === "done"));
  console.log("Verified installed production Web, browser login callback, WebSocket command delivery and event acknowledgement.");
} finally {
  if (login && login.exitCode === null) login.kill("SIGTERM");
  await transport?.close();
  await site.close();
}
