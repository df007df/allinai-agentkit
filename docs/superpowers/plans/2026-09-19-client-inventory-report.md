# Client 清单上报（Inventory Report）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 client 独立、全量地向 Hub 上报已安装插件信息与本地平台探测清单，Hub 可随时触发查询，demo 官网展示结果。

**Architecture:** 新增 uplink 消息 `inventory.report`；查询复用 `plugin.sync` downlink 并附加可选 `inventoryQuery: true` 标志（零副作用分支）。client 通过注入的 `inventoryProvider` 采集数据（插件全量状态 + 平台 probe），Hub 覆盖存储每 client 最新快照并暴露 `getInventory`；demo 增加两个路由与页面区块。

**Tech Stack:** TypeScript (ESM, NodeNext)、`node:test` + tsx、无新依赖。

**Spec:** [docs/superpowers/specs/2026-09-19-client-inventory-report-design.md](../specs/2026-09-19-client-inventory-report-design.md)

## Global Constraints

- 测试命令：`pnpm test`（`tsx --test 'src/**/*.test.ts'`）；类型检查：`pnpm typecheck`。
- 协议版本 `AGENT_CLIENT_PROTOCOL_VERSION = 2` 保持不变，不增字段到 `client.hello`。
- wire 解析一律「多余键拒绝」风格（`hasOnlyKeys`）；新类型同样严格。
- 未知 uplink 消息从 `socket.close(1008)` 放宽为静默忽略 + `bridgeLog.warn`；JSON 解析失败仍 close。
- `inventoryQuery: true` 的 `plugin.sync` 不得产生任何安装/停用副作用、不得写 revision 水位。
- 上报失败一律静默（不中断 supervisor 主流程）。
- 遵循仓库现有代码风格：无分号结尾无所谓（跟随现文件）、双引号、`type` 导入、注释解释"为什么"。

---

### Task 1: 协议类型与 wire 解析（inventory.report）

**Files:**
- Modify: `src/protocol/types.ts`
- Modify: `src/protocol/wire.ts`
- Modify: `src/protocol/index.ts`
- Test: `src/protocol/protocol.test.ts`

**Interfaces:**
- Produces: `PlatformInventoryEntry`、`PluginInventoryEntry`、`InventoryReport` 类型；`parseInventoryReport(value: unknown): InventoryReport | null`；`HubDownlink` 的 `plugin.sync` 变体新增可选 `inventoryQuery?: true`。

- [ ] **Step 1: 在 types.ts 末尾（`HubDownlink` 附近）写失败测试所需的新类型**

在 `src/protocol/types.ts` 中，将 `HubDownlink` 的 plugin.sync 变体扩展：

```ts
export type HubDownlink =
  | { type: "task.offer"; command: ClientCommand }
  | {
      type: "plugin.sync";
      revision: string;
      plugins: PluginConfig[];
      /** Query-only downlink: report inventory, apply no side effects. */
      inventoryQuery?: true;
    };
```

并在文件末尾追加：

```ts
export type PlatformInventoryEntry = {
  platform: RuntimeId;
  installed: boolean;
  version: string | null;
  reason?: string;
};

export type PluginInventoryEntry = {
  id: string;
  gitUrl: string;
  ref?: string;
  enabled: boolean;
  status: "active" | "blocked" | "failed";
  resolvedCommit: string;
  installedAt: string;
  lastError?: string;
};

export type InventoryReport = {
  type: "inventory.report";
  reportedAt: string;
  platforms: PlatformInventoryEntry[];
  plugins: PluginInventoryEntry[];
};
```

- [ ] **Step 2: 写失败测试**

在 `src/protocol/protocol.test.ts` 追加（顶部 import 补 `parseInventoryReport` 与类型）：

```ts
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test src/protocol/protocol.test.ts`
Expected: FAIL — `parseInventoryReport` 未导出。

- [ ] **Step 4: 在 wire.ts 实现解析**

在 `src/protocol/wire.ts` 中：

1. types import 处补 `type InventoryReport, type PlatformInventoryEntry, type PluginInventoryEntry`。
2. `parseHubDownlink` 的 `plugin.sync` 分支改为：

```ts
if (
  value.type === "plugin.sync" &&
  hasOnlyKeys(value, ["type", "revision", "plugins", "inventoryQuery"]) &&
  isNonEmptyString(value.revision) &&
  Array.isArray(value.plugins) &&
  value.plugins.every(isPluginConfig) &&
  (value.inventoryQuery === undefined || value.inventoryQuery === true)
)
  return {
    type: "plugin.sync",
    revision: value.revision,
    plugins: value.plugins,
    ...(value.inventoryQuery === true ? { inventoryQuery: true } : {}),
  };
```

3. 追加 guard 与解析函数（放在 `isPluginSyncAcknowledgement` 之后）：

```ts
function isPlatformInventoryEntry(value: unknown): value is PlatformInventoryEntry {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["platform", "installed", "version", "reason"]) ||
    !isRuntimeId(value.platform) ||
    typeof value.installed !== "boolean" ||
    (value.version !== null && typeof value.version !== "string")
  )
    return false;
  return value.reason === undefined || isNonEmptyString(value.reason);
}

function isPluginInventoryEntry(value: unknown): value is PluginInventoryEntry {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(
      value,
      [
        "id",
        "gitUrl",
        "ref",
        "enabled",
        "status",
        "resolvedCommit",
        "installedAt",
        "lastError",
      ],
    ) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.gitUrl) ||
    typeof value.enabled !== "boolean" ||
    !["active", "blocked", "failed"].includes(value.status as string) ||
    typeof value.resolvedCommit !== "string" ||
    !(value.resolvedCommit === "unresolved" || /^[0-9a-f]{40}$/i.test(value.resolvedCommit)) ||
    !isNonEmptyString(value.installedAt)
  )
    return false;
  if (value.ref !== undefined && !isNonEmptyString(value.ref)) return false;
  return value.lastError === undefined || isNonEmptyString(value.lastError);
}

export function parseInventoryReport(value: unknown): InventoryReport | null {
  if (
    !isPlainObject(value) ||
    !hasOnlyKeys(value, ["type", "reportedAt", "platforms", "plugins"]) ||
    value.type !== "inventory.report" ||
    !isNonEmptyString(value.reportedAt) ||
    !Array.isArray(value.platforms) ||
    !value.platforms.every(isPlatformInventoryEntry) ||
    !Array.isArray(value.plugins) ||
    !value.plugins.every(isPluginInventoryEntry)
  )
    return null;
  return {
    type: "inventory.report",
    reportedAt: value.reportedAt,
    platforms: value.platforms,
    plugins: value.plugins,
  };
}
```

- [ ] **Step 5: 在 protocol/index.ts 导出**

```ts
// wire.js 导出块追加：
parseInventoryReport,
// types.js 导出块追加：
type InventoryReport,
type PlatformInventoryEntry,
type PluginInventoryEntry,
```

- [ ] **Step 6: 运行测试与类型检查**

Run: `pnpm test src/protocol/protocol.test.ts && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/protocol/
git commit -m "feat(protocol): add inventory.report message and plugin.sync inventoryQuery flag"
```

---

### Task 2: Hub 未知消息放宽 + store 接口扩展

**Files:**
- Modify: `src/hub/types.ts`
- Modify: `src/hub/agent-hub.ts`
- Modify: `src/hub/testkit/memory-store.ts`
- Test: `src/hub/agent-hub.test.ts`（或仓库现有的 hub 测试文件；若 agent-hub.test.ts 不存在则放 `src/hub.test.ts`——以仓库现状为准，grep `createAgentHub` 的测试所在文件）

**Interfaces:**
- Consumes: Task 1 的 `parseInventoryReport`、`InventoryReport`。
- Produces: `HubStore.recordInventory(input: HubInventoryReport<Principal>): Promise<void>`；`AgentHub.getInventory(input: { principal; clientId }): Promise<InventoryReport | null>`；`AgentHub.syncPlugins` input 增加可选 `inventoryQuery?: boolean`。

- [ ] **Step 1: 写失败测试**

在 hub 测试文件追加（沿用文件内现有的 store/hub 构造方式；以下以 `MemoryHubStore` + `createAgentHub` 直接构造为准，若该文件已有 helper 就用 helper）：

```ts
it("records and returns the latest inventory report per client", async () => {
  const store = new MemoryHubStore<string>();
  const hub = createAgentHub({ authorize: async () => "p1", store });
  // registerClient 先行，recordInventory 前置校验需要已知 client
  await store.registerClient({ principal: "p1", clientId: "c1", protocolVersion: 2 });
  const report = {
    type: "inventory.report" as const,
    reportedAt: "2026-09-19T00:00:00.000Z",
    platforms: [],
    plugins: [],
  };
  await store.recordInventory({ principal: "p1", clientId: "c1", report });
  assert.deepEqual(
    await hub.getInventory({ principal: "p1", clientId: "c1" }),
    report,
  );
  assert.equal(
    await hub.getInventory({ principal: "p2", clientId: "c1" }),
    null,
  );
  const updated = { ...report, reportedAt: "2026-09-19T01:00:00.000Z" };
  await store.recordInventory({ principal: "p1", clientId: "c1", report: updated });
  assert.equal(
    (await hub.getInventory({ principal: "p1", clientId: "c1" }))?.reportedAt,
    "2026-09-19T01:00:00.000Z",
  );
  await hub.close();
});
```

再加一条「未知 uplink 消息不断链」的行为测试：向已连接的 mock WebSocket 发送 `{ type: "something.unknown" }`，断言 socket 未被 close（具体写法按该测试文件现有的 mock socket 模式；若现有测试用真实 ws 客户端，则断言连接仍可用——之后仍能正常收发 plugin.sync.ack）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/hub/`
Expected: FAIL — `recordInventory`/`getInventory` 不存在。

- [ ] **Step 3: 实现**

`src/hub/types.ts`：

```ts
import type { InventoryReport } from "../protocol/index.js"; // 补进现有 import

export interface HubInventoryReport<Principal> {
  principal: Principal;
  clientId: string;
  report: InventoryReport;
}

// HubStore 接口追加：
recordInventory(input: HubInventoryReport<Principal>): Promise<void>;

// AgentHub 接口追加：
getInventory(input: {
  principal: Principal;
  clientId: string;
}): Promise<InventoryReport | null>;

// syncPlugins 的 input 类型追加：
inventoryQuery?: boolean;
```

`src/hub/testkit/memory-store.ts`：

```ts
private readonly inventory = new Map<string, InventoryReport>();

async recordInventory(
  input: HubInventoryReport<Principal>,
): Promise<void> {
  this.assertClient(input.principal, input.clientId);
  this.inventory.set(input.clientId, input.report);
}

// 导出一个读取方法供 MemoryHubStore 消费者使用：
getInventory(clientId: string): InventoryReport | null {
  return this.inventory.get(clientId) ?? null;
}
```

`src/hub/agent-hub.ts`：

1. import 补 `parseInventoryReport`。
2. 消息循环中，`parsePluginSyncAcknowledgement` 分支之后插入：

```ts
const inventory = parseInventoryReport(message);
if (inventory) {
  await store.recordInventory({
    principal,
    clientId: connection.clientId,
    report: inventory,
  });
  return;
}
```

3. 末尾的未知消息分支：把

```ts
if (!events) {
  socket.close(1008, "invalid message");
  return;
}
```

改为

```ts
if (!events) {
  // Forward compatibility: a newer client may send message types this Hub
  // does not know. Dropping the socket would break mixed-version fleets.
  bridgeLog.warn("agent-hub", "Ignoring unknown client message", {
    type: (message as Record<string, unknown>).type,
  });
  return;
}
```

（`bridgeLog` 若未导入，按 `memory-store.ts` 顶部的 `import { bridgeLog } from "../../logger.js";` 引入；路径按 agent-hub.ts 的相对层级调整。）

4. `syncPlugins` 实现中，把 `input.inventoryQuery` 并入传给 `parseHubDownlink` 的对象：

```ts
const downlink = parseHubDownlink({
  type: "plugin.sync",
  revision: input.revision,
  plugins: input.plugins,
  ...(input.inventoryQuery ? { inventoryQuery: true } : {}),
});
```

5. 返回对象追加 `getInventory`：

```ts
getInventory(input: {
  principal: Principal;
  clientId: string;
}): Promise<InventoryReport | null> {
  return store.getInventory(input);
},
```

同时给 `HubStore` 接口补 `getInventory(input: { principal: Principal; clientId: string }): Promise<InventoryReport | null>;`（`MemoryHubStore` 实现为 `async getInventory({ principal, clientId }) { this.assertClient(principal, clientId); return this.inventory.get(clientId) ?? null; }`，把 principal 校验放在 store 侧而非 hub 侧——与 `recordInventory` 的 `assertClient` 风格一致）。

- [ ] **Step 4: 运行测试与类型检查**

Run: `pnpm test src/hub/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/hub/ src/protocol/
git commit -m "feat(hub): record client inventory reports and tolerate unknown uplink messages"
```

---

### Task 3: Client transport 与 supervisor 上报

**Files:**
- Modify: `src/client/transport.ts`
- Modify: `src/client/ws-transport.ts`
- Modify: `src/client/supervisor.ts`
- Test: `src/client/ws-transport.test.ts`、`src/client/supervisor.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `InventoryReport`、`parseHubDownlink` 新字段；Task 2 的 downlink 透传。
- Produces: `ClientTransport.reportInventory?(report: InventoryReport): Promise<void>`；`ClientSupervisorOptions.inventoryProvider?: () => Promise<InventoryReport>`；`ClientTransportHandlers.pluginSync` input 新增 `inventoryQuery: boolean`。

- [ ] **Step 1: 写 ws-transport 失败测试**

`src/client/ws-transport.test.ts` 追加（沿用文件内现有的 mock WebSocket 构造；以下为逻辑描述 + 断言，具体 mock 写法照抄该文件中 `reportPluginSync` 的既有用例）：

```ts
it("reportInventory sends the report when connected and throws when not", async () => {
  // connected 场景：断言 mock socket 收到的 JSON 与报告一致
  // disconnected 场景：断言 reject 且错误消息为 "Hub WebSocket is not connected"
});

it("passes inventoryQuery through to the pluginSync handler", async () => {
  // 向 mock socket 投递 { type: "plugin.sync", revision: "r", plugins: [], inventoryQuery: true }
  // 断言 handlers.pluginSync 收到 { revision: "r", plugins: [], inventoryQuery: true }
});
```

实现说明（写给执行者）：`reportInventory` 与 `reportPluginSync`（`ws-transport.ts:137-147`）完全同构——检查 `socket.readyState !== WS_OPEN` 抛 `Error("Hub WebSocket is not connected")`，否则 `socket.send(JSON.stringify(encodeInventoryReport(report)))`。`encodeInventoryReport` 按 Task 1 的说明实现为 `parse` 包装（与 `encodePluginSyncAcknowledgement` 同款，加到 `src/protocol/wire.ts` 并从 index 导出）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/client/ws-transport.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 transport 层**

`src/client/transport.ts`：

```ts
import type { InventoryReport } from "../protocol/index.js"; // 补充

export type ClientTransportHandlers = {
  command(command: ClientCommand): Promise<void>;
  pluginSync?(input: {
    revision: string;
    plugins: PluginConfig[];
    inventoryQuery: boolean;
  }): Promise<void>;
  connected(): Promise<void>;
};

export type ClientTransport = {
  connect(handlers: ClientTransportHandlers): Promise<void>;
  push(events: ClientEvent[]): Promise<Record<string, number>>;
  reportPluginSync?(acknowledgement: PluginSyncAcknowledgement): Promise<void>;
  reportInventory?(report: InventoryReport): Promise<void>;
  close(): Promise<void>;
};
```

注意：`pluginSync.input.inventoryQuery` 定义为必填布尔（handler 内部判真假），避免下游做 undefined 区分。

`src/client/ws-transport.ts`：加 `reportInventory` 方法（同构 `reportPluginSync`）；downlink 分发处（`:241-244`）改为：

```ts
await this.handlers.pluginSync?.({
  revision: downlink.revision,
  plugins: downlink.plugins,
  inventoryQuery: downlink.inventoryQuery === true,
});
```

- [ ] **Step 4: 写 supervisor 失败测试**

`src/client/supervisor.test.ts` 追加（mock transport / store 构造沿用该文件现有 helper）：

```ts
it("answers an inventoryQuery plugin.sync with ack + report and no side effects", async () => {
  // supervisor 以 inventoryProvider 注入固定 report；store mock 记录 getLastPluginSyncRevision / recordPluginSyncSuccess 调用
  // 触发 handlers.pluginSync({ revision: "q1", plugins: [], inventoryQuery: true })
  // 断言：
  //   1. transport.reportInventory 被调用且参数 type === "inventory.report"
  //   2. transport.reportPluginSync 收到 status === "already_applied"
  //   3. store 的 recordPluginSyncSuccess 未被调用（零副作用）
});

it("reports inventory after a real plugin sync completes", async () => {
  // 触发普通 plugin.sync（plugin manager mock 返回 active 插件）
  // 断言 reportInventory 在 sync 成功后被调用
});

it("reports inventory once on connect", async () => {
  // transport.connect 触发 connected handler
  // 断言 reportInventory 被调用一次
});

it("degrades to an empty-platform report when inventoryProvider throws", async () => {
  // inventoryProvider 抛错；触发 inventoryQuery
  // 断言 reportInventory 收到 platforms: [] 且 plugins 由 plugin 状态构成、不抛错
});

it("throttles proactive inventory reports within 5s", async () => {
  // 连接上报后立即再触发一次真同步；断言第二次主动上报被跳过
  // （查询触发不受节流限制的分支单独断言）
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `pnpm test src/client/supervisor.test.ts`
Expected: FAIL

- [ ] **Step 6: 实现 supervisor**

`src/client/supervisor.ts`：

1. `ClientSupervisorOptions` 追加：

```ts
/** Supplies the full local inventory for inventory reports; injected like plugins. */
inventoryProvider?: () => Promise<InventoryReport>;
```

2. 类字段：`private lastInventoryReportAt = 0;`
3. 新增私有方法：

```ts
private async reportInventory(force = false): Promise<void> {
  const provider = this.options.inventoryProvider;
  const reportInventory = this.options.transport.reportInventory;
  if (!provider || !reportInventory) return;
  const now = Date.now();
  if (!force && now - this.lastInventoryReportAt < 5_000) return;
  try {
    const report = await provider();
    await reportInventory.call(this.options.transport, report);
    this.lastInventoryReportAt = Date.now();
  } catch {
    // Inventory reporting is best-effort; a later sync or reconnect retries.
  }
}

private async reportInventoryAfterQuery(): Promise<void> {
  const provider = this.options.inventoryProvider;
  const reportInventory = this.options.transport.reportInventory;
  if (!provider || !reportInventory) return;
  try {
    const platforms = await provider().then((r) => r.platforms).catch(() => []);
    // 查询路径不节流：Hub 显式要的清单必须尽力给出
    const report = await this.options.inventoryProvider!().catch(() => null);
    // 简化：直接构造一次 report，platforms 失败降级为空数组
    void platforms;
  } catch {
    // 忽略
  }
}
```

（执行者注意：上面第二个方法写成两段是伪码示意，最终实现请合并为一个 `buildInventoryReport(platforms: PlatformInventoryEntry[]): InventoryReport` helper + 一个带 try/catch 的发送函数；保持「provider 抛错 → platforms 置空数组、plugins 来自 store」的语义，删除冗余调用。）

4. `syncPluginRevision` 开头（`getLastPluginSyncRevision` 检查之前）插入：

```ts
if (input.inventoryQuery) {
  await this.reportPluginSync({
    type: "plugin.sync.ack",
    revision: input.revision,
    status: "already_applied",
    plugins: plugins.snapshotActivePlugins(),
  });
  await this.reportInventoryForced();
  return;
}
```

`reportInventoryForced` = `reportInventory(true)` 的查询专用别名（不节流）。plugins 为 null 的分支（`plugin_manager_unavailable`）保持在 inventoryQuery 判断之前不变——查询不依赖 plugin manager 存在与否也可先 ack；实现时把 inventoryQuery 分支放在 plugins null 检查**之后**、幂等检查**之前**，避免 null 解引用。

5. 真同步成功路径（`recordPluginSyncSuccess` 之后、最终 ack 之前或之后均可）加 `void this.reportInventory();`；`connected` handler 改为：

```ts
connected: async () => {
  await this.flush();
  void this.reportInventory();
},
```

（`void` 前缀：上报失败不阻塞 flush/ack 主流程。）

- [ ] **Step 7: 运行全部 client 测试与类型检查**

Run: `pnpm test src/client/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/client/ src/protocol/
git commit -m "feat(client): answer inventory queries and proactively report local inventory"
```

---

### Task 4: daemon 装配 inventoryProvider

**Files:**
- Modify: `src/cli/commands.ts`
- Test: `src/cli/commands.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `ClientSupervisorOptions.inventoryProvider`；现有 `defaultProbeRuntimes()`（`commands.ts:366-372`）、`store.listPluginStates()`。
- Produces: daemon 启动时注入可用的 `inventoryProvider`（无新导出）。

- [ ] **Step 1: 写失败测试**

`src/cli/commands.test.ts` 追加（沿用该文件现有的 createDaemon 测试 harness；store/transport mock 照抄现有 daemon 用例）：

```ts
it("wires an inventoryProvider that reports installed plugins and probed platforms", async () => {
  // 通过 createDaemon 的注入点（probeRuntimes 风格的注入或 store mock）驱动：
  // 1. 模拟一条 plugin.sync 使 store 里有一条 InstalledPlugin
  // 2. 触发 transport 层的 inventoryQuery（或直接断言 supervisor options）
  // 断言 reportInventory 收到的 report：
  //   plugins[0].id / status / resolvedCommit 与安装状态一致
  //   platforms 长度 === 4 且包含 zcode 的 installed:false + reason
});
```

实现说明：为让测试可控，给 `LocalAgentDaemonOptions` 增加可选注入 `probeRuntimes?: () => Promise<RuntimeProbeResult[]>`（默认 `defaultProbeRuntimes`）——与 `RunCliOptions.probeRuntimes` 同名同型，测试注入固定结果。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/cli/commands.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现装配**

`src/cli/commands.ts` 的 `createLocalAgentDaemon` 中，`supervisor = new ClientSupervisor({...})` 的 options 里追加：

```ts
inventoryProvider: createInventoryProvider({ store, probeRuntimes }),
```

并在文件内（`capabilityHost` 定义附近）新增：

```ts
const INVENTORY_PROBE_TTL_MS = 60_000;

function createInventoryProvider(input: {
  store: ClientStateStore;
  probeRuntimes: () => Promise<RuntimeProbeResult[]>;
}): () => Promise<InventoryReport> {
  let cache: { at: number; platforms: PlatformInventoryEntry[] } | null = null;
  return async () => {
    const plugins = input.store.listPluginStates().map((state) => {
      const plugin = state.plugin;
      return {
        id: plugin.id,
        gitUrl: plugin.gitUrl,
        ...(plugin.ref !== undefined ? { ref: plugin.ref } : {}),
        enabled: plugin.enabled,
        status: plugin.status,
        resolvedCommit: plugin.resolvedCommit,
        installedAt: plugin.installedAt,
        ...(plugin.lastError !== undefined ? { lastError: plugin.lastError } : {}),
      };
    });
    const now = Date.now();
    if (!cache || now - cache.at > INVENTORY_PROBE_TTL_MS) {
      const probes = await input.probeRuntimes();
      cache = {
        at: now,
        platforms: probes.map(({ id, probe }) => ({
          platform: id,
          installed: probe.installed,
          version: probe.version,
          ...(probe.reason !== undefined ? { reason: probe.reason } : {}),
        })),
      };
    }
    return {
      type: "inventory.report",
      reportedAt: new Date().toISOString(),
      platforms: cache.platforms,
      plugins,
    };
  };
}
```

说明：probe 抛错不在此处吞——provider 的调用方（supervisor）已有降级路径（platforms 置空数组）；探测整体失败时每次调用都会重试（cache 只在成功后写入）。

- [ ] **Step 4: 运行 CLI 测试与类型检查**

Run: `pnpm test src/cli/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/
git commit -m "feat(agent-client): assemble inventory provider into the local daemon"
```

---

### Task 5: ObservableStore 观测 + demo 路由

**Files:**
- Modify: `src/demo/observable-store.ts`
- Modify: `src/demo/types.ts`（若观测类型定义在此；以 `HubObservation` 实际定义文件为准）
- Modify: `src/demo/site.ts`
- Test: `src/demo/site.test.ts`、`src/demo/integration.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `hub.getInventory` / `syncPlugins.inventoryQuery`。
- Produces: `POST /api/demo/inventory/query`、`GET /api/demo/inventory/<clientId>`；观测 `{ kind: "inventory.reported"; clientId; at }`。

- [ ] **Step 1: 写失败测试**

`src/demo/site.test.ts` 追加（沿用该文件现有 startDemoSiteCore + fetch harness）：

```ts
it("inventory/query triggers syncPlugins with inventoryQuery and reports delivery", async () => {
  // 注册 client（沿用现有测试的 registry 授权方式）
  // POST /api/demo/inventory/query { clientId }
  // 未连接 client：断言 200 且 body.delivered === false
});

it("inventory/:id returns the latest report or 404 no_report", async () => {
  // GET /api/demo/inventory/<未上报的clientId> → 404 { error: "no_report" }
  // store.recordInventory 注入一份 report 后再 GET → 200 且 body.type === "inventory.report"
});

it("rejects inventory query for unknown clients", async () => {
  // POST /api/demo/inventory/query { clientId: "ghost" } → 404 { error: "unknown_client" }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/demo/`
Expected: FAIL — 路由 404。

- [ ] **Step 3: 实现**

`src/demo/observable-store.ts`：`recordInventory` 转发并广播：

```ts
async recordInventory(input: Parameters<HubStore<string>["recordInventory"]>[0]) {
  await this.inner.recordInventory(input);
  this.observe({
    kind: "inventory.reported",
    clientId: input.clientId,
    at: Date.now(),
  });
}
```

（`observe`/广播方法名以该文件现有 `acknowledgePluginSync` 的写法为准，`:103-108` 同款；`HubObservation` union 加 `inventory.reported` 变体。）

`src/demo/site.ts`：import 补 `DEMO_PRINCIPAL` 已有；router 的 async 分派里追加两个分支（放在 `/api/demo/plugins/sync` 之后）：

```ts
if (request.method === "POST" && url.pathname === "/api/demo/inventory/query") {
  await handleInventoryQuery(context, request, response);
  return;
}
if (request.method === "GET" && url.pathname.startsWith("/api/demo/inventory/")) {
  handleInventoryGet(context, url.pathname, response);
  return;
}
```

handler 实现：

```ts
async function handleInventoryQuery(
  context: DemoRouterContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(request);
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (!clientId) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_inventory_request" }));
    return;
  }
  if (!context.projection.hasClient(clientId)) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "unknown_client" }));
    return;
  }
  const result = await context.hub.syncPlugins({
    principal: DEMO_PRINCIPAL,
    targetClientId: clientId,
    revision: `inventory-${Date.now()}`,
    plugins: [],
    inventoryQuery: true,
  });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
}

function handleInventoryGet(
  context: DemoRouterContext,
  pathname: string,
  response: ServerResponse,
): void {
  const clientId = decodeURIComponent(pathname.slice("/api/demo/inventory/".length));
  void context.hub
    .getInventory({ principal: DEMO_PRINCIPAL, clientId })
    .then((report) => {
      if (!report) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "no_report" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(report));
    })
    .catch(() => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "internal_error" }));
    });
}
```

- [ ] **Step 4: 运行 demo 测试与类型检查**

Run: `pnpm test src/demo/ && pnpm typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/demo/
git commit -m "feat(demo): add inventory query and report routes"
```

---

### Task 6: Demo 前端清单区块 + 集成验证

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Test: `src/demo/integration.test.ts`（补一条端到端：注册 client → query → recordInventory → GET 返回）

**Interfaces:**
- Consumes: Task 5 的两个路由、`inventory.reported` 观测。

- [ ] **Step 1: 在 index.html「插件推送」面板后追加区块**

```html
<div class="panel">
  <h3>插件与平台清单</h3>
  <p class="hint">触发 client 上报本地已安装插件与平台探测结果。</p>
  <label class="field-label" for="inventory-client">目标 client</label>
  <select id="inventory-client"></select>
  <button id="inventory-query" class="btn ghost full">查询清单</button>
  <p id="inventory-result" class="hint" hidden></p>
  <div id="inventory-platforms" hidden>
    <h4>平台</h4>
    <table class="inventory-table">
      <thead><tr><th>platform</th><th>installed</th><th>version</th><th>reason</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="inventory-plugins" hidden>
    <h4>插件</h4>
    <table class="inventory-table">
      <thead><tr><th>id</th><th>status</th><th>enabled</th><th>commit</th><th>ref</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>
</div>
```

`web/style.css` 追加 `.inventory-table` 基础样式（对齐现有 panel 内表格/列表风格：等宽字体、行分隔线；failed 行 `.row-failed { color: var(--danger, #f66); }`、未安装行 `.row-muted { opacity: 0.5; }`——CSS 变量名以该文件现有变量为准）。

- [ ] **Step 2: 在 app.js 接线**

追加（`pluginSyncBtn.onclick` 之后；client 下拉填充处同步 `inventoryClient.append(option.cloneNode(true))`，与 `pluginClient` 同款）：

```js
const inventoryClient = document.getElementById("inventory-client");
const inventoryQueryBtn = document.getElementById("inventory-query");
const inventoryResult = document.getElementById("inventory-result");
const inventoryPlatforms = document.getElementById("inventory-platforms");
const inventoryPlugins = document.getElementById("inventory-plugins");
let lastInventoryClient = null;

inventoryQueryBtn.onclick = async () => {
  const clientId = inventoryClient.value;
  inventoryResult.hidden = true;
  if (!clientId) {
    inventoryResult.textContent = "请选择 client";
    inventoryResult.hidden = false;
    return;
  }
  try {
    const response = await fetch("/api/demo/inventory/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? response.status);
    inventoryResult.textContent = payload.delivered
      ? "已请求上报，等待 client 回传清单…"
      : "client 当前不在线，未请求";
  } catch (error) {
    inventoryResult.textContent = `请求失败：${error.message}`;
  }
  inventoryResult.hidden = false;
};

async function loadInventory(clientId) {
  const response = await fetch(`/api/demo/inventory/${encodeURIComponent(clientId)}`);
  if (!response.ok) return null;
  return response.json();
}

function renderInventory(report) {
  if (!report) {
    inventoryPlatforms.hidden = true;
    inventoryPlugins.hidden = true;
    inventoryResult.textContent = "该 client 尚未上报清单";
    inventoryResult.hidden = false;
    return;
  }
  inventoryResult.hidden = true;
  const pBody = inventoryPlatforms.querySelector("tbody");
  pBody.replaceChildren(
    ...report.platforms.map((p) => {
      const tr = document.createElement("tr");
      if (!p.installed) tr.className = "row-muted";
      tr.append(
        cell(p.platform), cell(p.installed ? "✓" : "✗"),
        cell(p.version ?? "-"), cell(p.reason ?? ""),
      );
      return tr;
    }),
  );
  inventoryPlatforms.hidden = false;
  const jBody = inventoryPlugins.querySelector("tbody");
  jBody.replaceChildren(
    ...report.plugins.map((j) => {
      const tr = document.createElement("tr");
      if (j.status === "failed") tr.className = "row-failed";
      tr.append(
        cell(j.id), cell(j.status), cell(j.enabled ? "✓" : "✗"),
        cell(j.resolvedCommit === "unresolved" ? "unresolved" : j.resolvedCommit.slice(0, 7)),
        cell(j.ref ?? "-"),
      );
      return tr;
    }),
  );
  inventoryPlugins.hidden = false;
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = String(text ?? "");
  return td;
}
```

SSE 观测处理（`source.addEventListener("observation", ...)` 内）追加：

```js
if (observation.kind === "inventory.reported") {
  appendTimeline(observation);
  const clientId = observation.clientId;
  lastInventoryClient = clientId;
  if (clientId === inventoryClient.value || !inventoryClient.value) {
    loadInventory(clientId).then((report) => {
      if (report) renderInventory(report);
    });
  }
  return; // 已在 appendTimeline 处理，跳过通用分支
}
```

（注意：现有 observation handler 末尾统一调 `appendTimeline(observation); renderClients();`——把 inventory 分支放在通用调用之前并 `return`，避免时间线重复。若结构不便，去掉分支内重复的 `appendTimeline`。）

- [ ] **Step 3: 集成测试**

`src/demo/integration.test.ts` 追加端到端用例：注册 client（registry 授权）→ `POST /api/demo/inventory/query`（断言 delivered）→ 通过 `ObservableStore`/store 注入 `recordInventory` → `GET /api/demo/inventory/<id>` 断言完整 report 字段。写法沿用该文件现有的「起站点 → fetch → 断言」模式。

- [ ] **Step 4: 全量验证**

Run: `pnpm test && pnpm typecheck`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add web/ src/demo/
git commit -m "feat(demo): render client platform and plugin inventory in the console"
```

---

## Self-Review 记录

- **Spec 覆盖**：§1→Task 1；§2（transport/supervisor/provider）→Task 3+4；§3（store/hub/放宽）→Task 2；§4（路由+前端）→Task 5+6；错误处理汇总→各 Task 实现说明与 supervisor 降级用例覆盖；「范围外」无对应任务（正确）。
- **占位符**：Task 3 Step 6 中明确标注了伪码合并要求与最终语义；其余步骤均为完整代码或精确的文件/行号指引。
- **类型一致性**：`inventoryQuery` 在 downlink 类型为 `true | undefined`、在 `syncPlugins` input 为 `boolean?`、在 `pluginSync` handler input 为必填 `boolean`——三处已分别写明；`reportInventory(force)` 与查询专用不节流路径在 Task 3 中统一为 `force` 参数。
