# Changelog

## 0.6.1 — 2026-10-04

- 重写项目首页介绍，按七组使用场景说明主要功能、解决的问题与提供的方案。
- 统一官网、完整文档和插件文档的项目定位、功能分组与操作指引。
- 补充 CLI 使用示例与配置说明，修正移动端文档导航布局。
- 更新 Hub 与 Client npm 包说明及所有当前版本标记。

## 0.6.0 — 2026-10-04

- 将原 `@allin-ai/agentkit` 拆分为两个独立公开包：`@allin-ai/agentkit-hub` 提供 Hub SDK、Console、Issues、React UI 与预构建 Next.js 控制台；`@allin-ai/agentkit-client` 提供本地 Client、执行器、插件与 CLI。
- Hub 主入口仅加载 SDK 与协议。Client 的生产依赖仅包含 `ws`；两个包没有相互的生产依赖，公共协议源码分别编译，不发布第三个共享包。
- Hub 控制台改用 `allinai-agentkit-hub web`，支持 `--port`、`--host`、绝对路径 `--config-dir` 与源码开发用的 `--dev`。原 `agentkit-web` 合并到 Hub 包。
- 官方控制台将授权和 Issues 分别保存到 `tokens.db`、`issues.db`，重启后保留授权、Issue 状态与评论。
- 修复 Console 对 SSE 观察消息的解析，使 Client 注册、心跳、项目清单与执行事件在页面实时更新。
- 更新安装脚本、CLI 手册和 Pages 文档，增加双包产物校验与同一提交的发布重试检查。

### 从旧包迁移

```bash
npm uninstall -g @allin-ai/agentkit @allin-ai/agentkit-web
npm install -g @allin-ai/agentkit-client @allin-ai/agentkit-hub
allinai-agentkit-hub web
```

Hub、Console、Issues 的导入改为 `@allin-ai/agentkit-hub/...`；本地 Client 的导入改为 `@allin-ai/agentkit-client/...`。将 `allinai-agentkit web` 替换为 `allinai-agentkit-hub web`。其他 Client 命令、v2 wire 协议与默认数据目录 `~/.allinai/agent` 保持兼容。
