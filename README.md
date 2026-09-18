# agent-client

`agent-client` is a Node.js protocol, Hub, client, runtime-adapter, and plugin package for durable local agent execution. It is intentionally host-neutral: neither AllInAI nor Magic Learning databases, token models, UI, processes, or domain services are bundled.

The package is prepared for release as `@allin-ai/agent-client@0.2.0`. It requires Node.js `>=22.18.0` and publishes the compiled package artifact, including the `/hub` and `/hub/testkit` subpaths.

## Extraction status and legacy compatibility

This preparation does not publish a release. Registry access, release authorization, CI/secrets, and the publication process remain separate authorized follow-up work.

The existing `allinai-agent` executable, `.allinai/agent` local state directory, service labels, keychain service, plugin filename, and deprecated protocol import paths are retained only as local compatibility identifiers. They do not import an AllInAI host module or resolve a parent workspace directory, so the package can be copied out as its own repository without redesign. Test fixtures likewise retain their historical identifiers only where they verify that compatibility behavior.

## Requirements and package-local commands

Node.js `>=22.18.0` is required. From this package directory after installing its own dependencies:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:artifact
```

`verify:artifact` packs the package, installs that tarball into a temporary Hub-only consumer with optional SDKs omitted, imports `/hub`, then removes only the tarball and temporary directory it created.

## Public subpaths

```ts
import * as protocol from "@allin-ai/agent-client/protocol";
import { createAgentHub } from "@allin-ai/agent-client/hub";
import { createMemoryHub } from "@allin-ai/agent-client/hub/testkit";
import { WsClientTransport } from "@allin-ai/agent-client";
import { createCodexAdapter } from "@allin-ai/agent-client/runtime";
import { PluginManager } from "@allin-ai/agent-client/plugins";
```

- `/protocol` contains the versioned wire schema and encoders/parsers.
- `/hub` contains the generic Node HTTP/WebSocket coordinator and `HubStore` port.
- `/hub/testkit` contains volatile memory helpers for tests and local examples only.
- The root, `/runtime`, `/plugins`, and legacy focused subpaths expose client execution and plugin facilities.

`createMemoryHub` is not a production database. It loses clients, offers, events, and acknowledgements at process restart; it is deliberately not exported from the root or `/hub`.

## Host-owned Hub integration

The host owns all business state and integration concerns: database/ORM, identity and token validation, authorization, pages/UI, HTTP process lifecycle, and its implementation of `HubStore<Principal>`. `agent-client` stores only live WebSocket references. It does not start a listener, pick an identity model, or persist offers/events itself.

The default WebSocket endpoint is `/api/agent-hub/v2/ws`. A host that is migrating can pass a different absolute `pathPrefix`, and clients pass the same prefix to `WsClientTransport`.

```ts
import http from "node:http";
import { createAgentHub, type HubStore } from "@allin-ai/agent-client/hub";

type Principal = { accountId: string };

const store: HubStore<Principal> = {
  async registerClient({ clientId }) {
    return { clientId, connectionKey: `example:${clientId}` };
  },
  async heartbeat() {},
  async listPendingOffers() {
    return [];
  },
  async enqueueOffer(input) {
    return {
      offerId: crypto.randomUUID(),
      targetClientId: input.targetClientId,
      connectionKey: `example:${input.targetClientId}`,
      command: input.command,
    };
  },
  async ingestEvents() {
    return {};
  },
  async acknowledgePluginSync() {},
};

const hub = createAgentHub({
  store,
  authorize: async (token) =>
    token === process.env.AGENT_TOKEN ? { accountId: "example-account" } : null,
  pathPrefix: "/api/agent-hub/v2",
});

// Create this server without an application request listener. `hub.attach`
// owns the Hub endpoint and delegates all other HTTP requests to `fallback`.
const server = http.createServer();
hub.attach(server, {
  fallback(request, response) {
    response.writeHead(404);
    response.end(`Unknown path: ${request.url}`);
  },
});
server.listen(8788);
```

In a real host, every Store method must enforce that opaque authenticated principal. Offers are persisted before delivery, event acknowledgement follows durable ingestion, and the host provides a stable private `connectionKey` for each authorized client ownership pair.

## Optional runtime SDKs

Hub-only consumers do not need or load any runtime adapter SDK. Runtime adapters are available when explicitly used and report a typed, actionable `OptionalRuntimeDependencyError` if the requested SDK is absent.

```bash
npm install @openai/codex-sdk
npm install @anthropic-ai/claude-agent-sdk
npm install @earendil-works/pi-coding-agent
```

After installing the desired SDK, use its adapter from `/runtime`; credentials, provider access, and runtime policy remain the host's responsibility.
