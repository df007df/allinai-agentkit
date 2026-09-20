# 发布步骤

1. 确认工作区干净：`git status`
2. 全量校验：`pnpm typecheck && pnpm test && pnpm build && pnpm verify:artifact`
3. 更新版本（如需）：编辑 `package.json` 的 `version`
4. 登录 npm：`npm login`
5. 发布：`npm publish --access public`
6. 验证：`npm view @allin-ai/agentkit version`

注意：`verify:artifact` 已校验 tarball 含 `web/` 资源、`./demo` 入口且 Hub-only 安装不引入任何 agent SDK。
