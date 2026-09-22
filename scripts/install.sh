#!/bin/sh
# allinai-agentkit 一键安装脚本
#
# 用法：
#   sh install.sh                 # 安装最新已发布版本到全局
#   sh install.sh 0.3.0           # 安装指定版本
#   sh install.sh --from-source   # 从当前仓库源码构建并全局链接（开发用）
#
# 脚本只做三件事：确认 Node.js >= 22.18、用 npm 全局安装（或源码构建）、
# 打印 `allinai-agentkit --help` 验证可用。安装后的登录与常驻：
#   allinai-agentkit login --hub http://127.0.0.1:4317
#   allinai-agentkit install   # 可选：注册为用户级常驻服务（launchd/systemd）
#   allinai-agentkit daemon

set -eu

PACKAGE_NAME="@allin-ai/agentkit"
BIN_NAME="allinai-agentkit"
REQUIRED_NODE_MAJOR=22
REQUIRED_NODE_MINOR=18

say() { printf '%s\n' "$*"; }
fail() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

# --- Node.js 检查 -----------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  fail "未找到 node。请先安装 Node.js >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}（https://nodejs.org）"
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ] ||
  { [ "$NODE_MAJOR" -eq "$REQUIRED_NODE_MAJOR" ] &&
    [ "$NODE_MINOR" -lt "$REQUIRED_NODE_MINOR" ]; }; then
  fail "Node.js 版本过低：$(node -v)。需要 >= ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}"
fi

# --- 全局安装目标目录 -------------------------------------------------------
NPM_GLOBAL_BIN="$(npm prefix -g 2>/dev/null)/bin" || NPM_GLOBAL_BIN=""
if ! command -v npm >/dev/null 2>&1; then
  fail "未找到 npm。请确认 Node.js 安装完整。"
fi

case "${1:-}" in
  --from-source)
    SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
    cd "$SCRIPT_DIR"
    say "==> 从源码安装（$(pwd)）"
    if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
      pnpm install
      pnpm build
    else
      npm install
      npm run build
    fi
    npm link
    ;;
  -h|--help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    say "==> 全局安装 ${PACKAGE_NAME}@latest"
    npm install -g "$PACKAGE_NAME@latest"
    ;;
  *)
    VERSION="$1"
    case "$VERSION" in
      [0-9]*) VERSION="@$VERSION" ;;
    esac
    say "==> 全局安装 ${PACKAGE_NAME}${VERSION}"
    npm install -g "${PACKAGE_NAME}${VERSION}"
    ;;
esac

# --- 验证 -------------------------------------------------------------------
if ! command -v "$BIN_NAME" >/dev/null 2>&1; then
  say ""
  say "安装完成，但 ${BIN_NAME} 不在 PATH 中。"
  say "npm 全局 bin 目录：${NPM_GLOBAL_BIN:-未知}"
  say "请把该目录加入 PATH 后重试 ${BIN_NAME} --help"
  exit 1
fi

say ""
say "==> ${BIN_NAME} 已就绪：$("$BIN_NAME" --help | head -1)"
say ""
say "下一步："
say "  ${BIN_NAME} init --hub https://your-hub.example    # 或先跑本机 Console"
say "  ${BIN_NAME} web                                     # 本机 Console：Hub + web UI"
say "  ${BIN_NAME} login --hub http://127.0.0.1:4317      # 浏览器授权"
say "  ${BIN_NAME} daemon                                  # 常驻接入"
say "  ${BIN_NAME} install                                 # 注册用户级常驻服务"
