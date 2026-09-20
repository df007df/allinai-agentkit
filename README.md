# allinai-agentkit

独立持久 **Agent Client**：连接 Hub，可靠执行本地平台 Agent（Codex / Claude / Pi，可选）与受策略门控的能力，并向上游回报状态。本仓库 = npm 包 `@allin-ai/agentkit` + CLI `allinai-agentkit` + 内置本地 demo 控制台（memory hub + 授权接入）。

官网（介绍与使用场景）：https://df007df.github.io/allinai-agentkit/ ，由 `site/` 目录经 GitHub Actions 自动发布。

## 快速开始（npm）

要求 Node.js ≥ 22.18。包已发布到 npm，无需克隆仓库：

```bash
# 终端 A：启动 demo 控制台 + hub（默认 http://127.0.0.1:4317）
npx @allin-ai/agentkit demo

# 终端 B：浏览器授权接入，然后常驻接入
npx @allin-ai/agentkit login --hub http://127.0.0.1:4317
npx @allin-ai/agentkit daemon
```

## 快速开始（本地源码）

```bash
pnpm install && pnpm build

# 终端 A：启动 demo 控制台 + hub（默认 http://127.0.0.1:4317）
node bin/allinai-agentkit demo

# 终端 B：浏览器授权接入
node bin/allinai-agentkit login --hub http://127.0.0.1:4317

# 终端 B：常驻接入
node bin/allinai-agentkit daemon
```

打开 http://127.0.0.1:4317 ：控制台会出现你的 client，可派发任务并观察协议事件时间线。

授权模型：demo 启动不发放任何全局 token；client 凭自己 config 里的唯一 clientId 发起 `login`，浏览器授权页确认后，web 内存中登记 `token → clientId` 并以此放行后续连接（内存态，重启即清空，需重新 login）。

## 安装（一键 sh 脚本）

```bash
sh scripts/install.sh                 # npm 全局安装最新版
sh scripts/install.sh 0.3.2           # 指定版本
sh scripts/install.sh --from-source   # 本仓库构建 + npm link（开发）
```

脚本会检查 Node.js ≥ 22.18，安装后验证 `allinai-agentkit --help`。

## 从 `@allin-ai/agent-client` 升级

包已更名为 `@allin-ai/agentkit`，CLI 命令由 `allinai-agent` 变为 `allinai-agentkit`：

```bash
npm uninstall -g @allin-ai/agent-client
allinai-agent uninstall        # 用旧命令移除旧服务（launchd/systemd）
npm install -g @allin-ai/agentkit
allinai-agentkit install       # 以新服务名重新注册
```

`~/.allinai/agent` 数据目录与 macOS 钥匙串凭据保持不变，升级后无需重新登录配对。

## 包结构

| 入口 | 内容 |
|---|---|
| `@allin-ai/agentkit/protocol` | 版本化 wire 协议与编解码 |
| `@allin-ai/agentkit/hub` | Node HTTP/WebSocket Hub（`HubStore` 端口） |
| `@allin-ai/agentkit/hub/testkit` | 测试用内存 Store/Hub（勿用于生产） |
| `@allin-ai/agentkit/client` | 可重连执行 client 与传输层 |
| `@allin-ai/agentkit/control` | daemon 本地控制面（Unix socket：健康 / 状态 / 清单） |
| `@allin-ai/agentkit/runtime` | Codex/Claude/Pi 运行时适配（可选 peer） |
| `@allin-ai/agentkit/plugins` | Git 插件仓库同步与装载 |
| `@allin-ai/agentkit/demo` | 本地 demo 控制台 + hub 服务 |

## CLI

```
allinai-agentkit <init|login|daemon|demo|install|status|logs|sync|restart|uninstall|doctor|projects|project|plugins>
allinai-agentkit project --name web --path /work/web    # 注册项目工作目录
allinai-agentkit project --name web --remove            # 移除
allinai-agentkit projects                               # 列出已注册项目
allinai-agentkit plugins [--refresh]                    # 查看已装插件；--refresh 重新上报 Hub
```

### 项目目录

项目在 client 本地 config.json 的 `projects` 中注册（`project add` 即写入）。Hub 下发的 `agent.run` 可携带 `payload.project`：

- 不带 `project`（或名字未注册）：使用各 runtime 的默认工作目录；
- 带 `project` 且已注册：在该目录中执行，同时把 `resolvedProjectPath` 附进执行上下文。

Hub 无法自选任意路径——只能从本地注册的目录里按名字挑选。

### 插件

- Hub 主动推送：`hub.syncPlugins({ principal, targetClientId, revision, plugins })`（demo 站点提供 `POST /api/demo/plugins/sync`）。
- client 收到后校验清单、克隆到不可变修订目录并原子激活，随后回 `plugin.sync.ack`（含每个插件的 resolvedCommit）。
- 本地随时查看：`allinai-agentkit plugins`；重新上报：`allinai-agentkit plugins --refresh`。

### 执行日志

daemon 把每条命令的接收、策略判定、runner 终态写入 `~/.allinai/agent/logs/agent.log`（滚动 JSONL，自动脱敏）。`allinai-agentkit logs [-f]` 查看并再次脱敏输出。

## 开发

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm verify:artifact
```

## 发布

推送 `v*` 标签触发 `.github/workflows/release.yml`：测试 → 类型检查 → `verify:artifact` → 经 trusted publishing 发布到 npm（附 SLSA provenance，无需本地凭据）。

```bash
# 本例：发布 0.3.3
npm version patch          # 或手改 package.json 的 version
git push --follow-tags
```

MIT License.
