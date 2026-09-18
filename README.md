# allinai-agentkit

独立持久 **Agent Client**：连接 Hub，可靠执行本地平台 Agent（Codex / Claude / Pi，可选）与受策略门控的能力，并向上游回报状态。本仓库 = npm 包 `@allin-ai/agent-client` + CLI `allinai-agent` + 内置 demo web（中文官网 + memory hub + 授权接入）。

## 快速开始（本地源码）

要求 Node.js ≥ 22.18。

```bash
pnpm install && pnpm build

# 终端 A：启动官网 + demo hub（默认 http://127.0.0.1:4317）
node bin/allinai-agent demo

# 终端 B：浏览器授权接入
node bin/allinai-agent login --hub http://127.0.0.1:4317

# 终端 B：常驻接入
node bin/allinai-agent daemon
```

打开 http://127.0.0.1:4317 ：控制台会出现你的 client，可派发任务并观察协议事件时间线。

无浏览器环境：`demo` 启动时终端打印 bootstrap token，改用
`allinai-agent init --hub <url> --token <token>`。

## 包结构

| 入口 | 内容 |
|---|---|
| `@allin-ai/agent-client/protocol` | 版本化 wire 协议与编解码 |
| `@allin-ai/agent-client/hub` | Node HTTP/WebSocket Hub（`HubStore` 端口） |
| `@allin-ai/agent-client/hub/testkit` | 测试用内存 Store/Hub（勿用于生产） |
| `@allin-ai/agent-client/client` | 可重连执行 client 与传输层 |
| `@allin-ai/agent-client/runtime` | Codex/Claude/Pi 运行时适配（可选 peer） |
| `@allin-ai/agent-client/demo` | 本官网 + demo hub 服务 |

## CLI

```
allinai-agent <init|login|daemon|demo|install|status|logs|sync|restart|uninstall|doctor>
```

## 开发

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm verify:artifact
```

## 发布

见 `docs/publish.md`（`npm publish --access public`，发布前必跑 `verify:artifact`）。

MIT License.
