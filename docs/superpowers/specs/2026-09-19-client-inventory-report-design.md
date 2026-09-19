# Client 清单上报（Inventory Report）设计

日期：2026-09-19
状态：已评审（用户逐段确认）

## 背景与目标

当前协议中，Hub 只能通过 `plugin.sync` 的回执（`plugin.sync.ack`）间接获知客户端激活插件的
`{id, resolvedCommit}` 快照，且没有「客户端本地安装了哪些平台」的信息。本设计新增一条独立的
uplink 消息，使 client 能主动、全量地上报：

1. **全部已安装插件信息**（非仅激活快照）：id、gitUrl、ref、enabled、status、resolvedCommit、
   installedAt、lastError。
2. **本地平台安装清单**：对四个平台（codex/claude/pi/zcode）逐个 `probe()` 的结果
   （installed/version/reason）。

触发机制（用户已确认）：**Hub 查询 + client 主动上报**。Hub 可随时拉取；client 在连接建立和
插件同步完成后也自发推送。

## 决策记录

| 决策点 | 结论 |
|--------|------|
| 触发机制 | Hub 查询 + 主动上报双通道 |
| 插件粒度 | 全量安装状态（含 blocked/failed） |
| 平台信息来源 | 运行时 `probe()`，结果缓存 60s |
| Demo 暴露 | 新增页面区块与 API 路由 |

## §1 协议层（src/protocol/types.ts + wire.ts）

### 新增 uplink 类型 `inventory.report`

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
  resolvedCommit: string;   // 未解析时为 "unresolved"
  installedAt: string;
  lastError?: string;
};

export type InventoryReport = {
  type: "inventory.report";
  reportedAt: string;       // ISO 8601
  platforms: PlatformInventoryEntry[];
  plugins: PluginInventoryEntry[];
};
```

wire 函数：`parseInventoryReport(value): InventoryReport | null`（严格键校验，风格对齐
`isPluginSyncAcknowledgement`）；无需独立 encode——上报方向由 client 构造，发送前用 parse 校验
（与 `encodePluginSyncAcknowledgement` 的实现方式一致）。

### Hub 下发扩展：`plugin.sync` 增加可选 `inventoryQuery?: true`

查询动作不新增 downlink 类型，复用现有链路：

```
{ type: "plugin.sync", revision: <任意非空>, plugins: [], inventoryQuery: true }
```

**`inventoryQuery: true` 的语义**：client 不执行任何安装/停用副作用（尤其不做「空数组=全停」）、
不记录 revision 幂等水位；照发 `plugin.sync.ack`（status=`already_applied`，快照取当前激活集），
并另发 `inventory.report`。

`parseHubDownlink` 相应扩展：`plugin.sync` 分支接受可选布尔字段 `inventoryQuery`，其余键不变。

### 兼容性

- 协议版本 `AGENT_CLIENT_PROTOCOL_VERSION = 2` 保持不变；`inventoryQuery` 为可选字段。
- 旧 client 收到 `inventoryQuery: true`：其 `parseHubDownlink`（旧代码）会因多余键拒绝该消息，
  downlink 分发对 null 静默丢弃（`ws-transport.ts:235-236`）——消息被忽略，无破坏性副作用。
  Hub 侧对所有连接发送（无需能力协商）；旧 client 不回 `inventory.report`，Hub 的
  `getInventory` 返回 null 即可。
- **旧 Hub 收到新消息**：现有消息循环对不匹配类型 `socket.close(1008, "invalid message")`
  （`agent-hub.ts:224-227`）。必须放宽为「JSON 合法但类型未知 → 静默忽略 + warn 日志」，
  否则新旧混布时旧 Hub 会踢掉上报中的新 client。

## §2 Client 侧（src/client/ + src/cli/commands.ts）

### transport（src/client/transport.ts）

`ClientTransport` 增加可选方法（与 `reportPluginSync` 同风格，旧实现缺省不报错）：

```ts
reportInventory?(report: InventoryReport): Promise<void>;
```

`ClientTransportHandlers` 不新增回调——查询仍走现有 `pluginSync` handler（其 input 类型扩展
携带 `inventoryQuery: boolean`，见 `ws-transport.ts:241-244` 的分发处）。

### ws-transport（src/client/ws-transport.ts）

- `reportInventory()` 与 `reportPluginSync()` 同构：socket 未连接抛错；已连接
  `JSON.stringify(report)` 发出。
- downlink 分发处把 `inventoryQuery` 透传给 `pluginSync` handler。

### supervisor（src/client/supervisor.ts）

- **构造选项**新增 `inventoryProvider?: () => Promise<InventoryReport>`。supervisor 不探测平台、
  不读插件目录，仅调用注入的 provider（依赖方向与 `plugins`/`capabilityHost` 注入一致）。
- **`syncPluginRevision` 特判**：input 带 `inventoryQuery` 时——
  1. 跳过 `getLastPluginSyncRevision` 幂等检查与 `plugins.sync()` 调用（零副作用）；
  2. 照发 `plugin.sync.ack`（status=`already_applied`，`snapshotActivePlugins()` 取当前值）；
  3. 调 `inventoryProvider()` 并 `reportInventory()`；provider 抛错则发不带 platforms 的降级
     report（platforms 置空数组）并继续。
- **主动上报时机**：
  - `connected()` handler 内上报一次（重连后 Hub 重投 pending offers，顺带刷新清单）；
  - `handlePluginSync` 完成真同步后上报一次（安装状态已变）。
  - 失败静默（与 `reportPluginSync` 容错一致）；简单节流：距上次成功上报 <5s 跳过主动上报
    （查询触发的上报不受节流限制）。

### inventoryProvider 实现（src/cli/commands.ts 的 createLocalAgentDaemon）

- **插件部分**：`store.listPluginStates().map(s => s.plugin)` 直映 `PluginInventoryEntry[]`
  （字段一一对应）。
- **平台部分**：复用 `defaultProbeRuntimes()`（`commands.ts:366-372`，registry 逐个 `probe()`）；
  结果缓存 60s（probe 含 SDK 动态 import，zcode 恒 fail-closed）；`Promise.all` 并发，
  单个 probe 抛错转 `installed: false + reason`。

### 测试

- `supervisor.test.ts`：inventoryQuery 特判（无副作用、ack=already_applied、发出 report）；
  连接后上报；真同步后上报；节流；provider 抛错降级。
- `ws-transport.test.ts`：reportInventory 连接态/断连态；downlink `inventoryQuery` 透传。

## §3 Hub 侧（src/hub/ + src/protocol/wire.ts）

### HubStore（src/hub/types.ts）

```ts
export interface HubInventoryReport<Principal> {
  principal: Principal;
  clientId: string;
  report: InventoryReport;
}

// HubStore 新增：
recordInventory(input: HubInventoryReport<Principal>): Promise<void>;
```

语义：每 client **覆盖写最新一份**（查询的是当前状态，不保留历史）。鉴权沿现有路径：
消息循环处已持有 `connection.principal`/`connection.clientId`，直接透传。

### AgentHub 公共接口（src/hub/types.ts + agent-hub.ts）

```ts
getInventory(input: { principal: Principal; clientId: string }):
  Promise<InventoryReport | null>;   // null = 从未上报
```

读取走 store 最新快照；查询触发走 `syncPlugins` 的 `inventoryQuery` 标志（见 §1），
两条路分开。

### syncPlugins 扩展

input 增加可选 `inventoryQuery?: boolean`，透传进 downlink（经 `parseHubDownlink` 往返校验）。

### 消息循环（agent-hub.ts）

1. 在 `parsePluginSyncAcknowledgement` 分支后、`parseClientEventBatch` 前插入
   `parseInventoryReport(message)` → `store.recordInventory(...)`。
2. **放宽未知消息**：JSON 合法但所有已知类型不匹配 → 静默忽略 + warn 日志（替代
   `close(1008, "invalid message")`）。仅 JSON 解析失败仍保留踢连接。

### 内建 store 实现

- `src/hub/testkit/memory-store.ts`：`Map<clientId, InventoryReport>` 覆盖写；
  `recordInventory`/`getInventory` 实现。
- demo `ObservableStore`（src/demo/observable-store.ts）：转发 inner store，并发观测
  `{ kind: "inventory.reported"; clientId: string; at: number }`。

### 测试

- `memory-hub.test.ts`：record/get 往返；principal 隔离（A 的 principal 读不到 B）；
  覆盖写语义。
- `protocol.test.ts`：`parseInventoryReport` 合法/非法用例；`parseHubDownlink` 带
  `inventoryQuery` 的往返与键约束。

## §4 Demo 官网（src/demo/site.ts + web/）

### HTTP 路由

- **`POST /api/demo/inventory/query`** — body `{ clientId }`。client 不存在 404
  `unknown_client`；否则 `hub.syncPlugins({ principal: DEMO_PRINCIPAL, targetClientId,
  revision: \`inventory-${Date.now()}\`, plugins: [], inventoryQuery: true })`，
  返回 `{ delivered }`。
- **`GET /api/demo/inventory/<clientId>`** — `hub.getInventory()`，返回最新快照；
  从未上报 404 `no_report`。路由实现为 pathname 前缀解析（对齐现有精确匹配风格，
  单租户直接用 `DEMO_PRINCIPAL`）。

### 前端（web/index.html + web/app.js）

新增「插件与平台清单」区块（表单风格对齐现有区块）：

- client 下拉 + 「查询清单」按钮 → query 路由；`delivered:false` 提示「client 不在线」。
- SSE 观测 `inventory.reported`：时间线加分支文案；收到后自动
  `GET /api/demo/inventory/<clientId>` 渲染：
  - **平台表**：platform / installed / version / reason，未安装行置灰；
  - **插件表**：id / status / enabled / commit(前 7 位) / ref / gitUrl，failed 行红字
    显示 lastError。
- 无数据显示「该 client 尚未上报清单」。不做自动轮询，SSE 观测驱动。

### 测试

`site.test.ts` / `integration.test.ts`：query 路由触发 downlink（含离线 delivered:false）；
上报后 GET 返回最新快照；未上报 404。

## 错误处理汇总

| 场景 | 行为 |
|------|------|
| 上报时 socket 断开 | `reportInventory` 抛错，supervisor 静默吞掉；下次连接/同步后重报 |
| inventoryProvider 抛错 | 降级 report（platforms 空数组），plugins 照报 |
| probe 单平台失败 | `installed: false + reason`，不拖垮整份清单 |
| inventoryQuery 到达旧 client | 旧 parse 拒绝该消息，静默忽略，无副作用 |
| inventory.report 到达旧 Hub | 放宽后的消息循环静默忽略，不断链 |
| Hub store recordInventory 失败 | 沿用现有 `queue()` 容错：close(1011)（与 ack 处理一致） |

## 范围外（明确不做）

- 不做自动轮询/心跳式清单上报（仅连接后 + 同步后 + 查询触发）。
- 不保留清单历史（每 client 仅最新一份）。
- 不新增 CLI 命令（`status` 已能本地查询；本次只解决 Hub 侧可见性）。
- 不做能力协商（协议版本保持 2，靠可选字段与放宽解析实现混布兼容）。
