#!/usr/bin/env bash
set -euo pipefail

# overSeer Unix/macOS 安装/首次运行脚本
# 用法：bash scripts/install.sh

echo ""
echo "============================================"
echo "  overSeer 安装与首次运行向导"
echo "============================================"
echo ""

# 1. 检查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[X] 未检测到 Node.js。请先安装 Node.js >= 20："
  echo "    https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[X] Node.js 版本过低。当前 $(node --version)，需要 >= 20"
  exit 1
fi
echo "[OK] Node.js $(node --version)"

# 2. 检查 Git
if ! command -v git >/dev/null 2>&1; then
  echo "[X] 未检测到 git。请安装 git 并加入 PATH："
  echo "    https://git-scm.com/"
  exit 1
fi
echo "[OK] git"

# 3. 安装依赖
if [ ! -d "node_modules" ]; then
  echo "[*] 安装依赖..."
  npm install
else
  echo "[OK] node_modules 已存在"
fi

# 4. 创建 data/logs
mkdir -p data logs

# 5. 检查密钥配置
if [ -f "config/.secrets.yaml" ]; then
  echo "[OK] 已存在 config/.secrets.yaml"
else
  echo "[*] 创建 config/.secrets.yaml 模板..."
  cp config/.secrets.example.yaml config/.secrets.yaml
  echo "[OK] 已创建模板。请编辑 config/.secrets.yaml 填入 providers.glm.apiKey，"
  echo "    或设置环境变量：export OVERSEER_GLM_API_KEY=你的key"
fi

# 6. 运行 doctor
echo ""
echo "[*] 运行 overSeer doctor 自检..."
if ! npm run dev -- doctor; then
  echo ""
  echo "[!] doctor 有未通过项，请按上方建议修复。"
  echo "    常见问题："
  echo "      - 没填 GLM key：复制 config/.secrets.example.yaml -> config/.secrets.yaml 并填 apiKey"
  echo "      - 本地 fallback 没起：启动 Ollama，并确认 http://localhost:11434/v1 可达"
  exit 1
fi

echo ""
echo "============================================"
echo "  安装完成。常用命令："
echo "============================================"
echo ""
echo "  npm run dev -- status         查看状态"
echo "  npm run dev -- chat \"你好\"    聊天"
echo "  npm run dev -- tui            启动 TUI"
echo "  npm run dev -- daemon start   启动 daemon"
echo "  npm run dev -- cycle run      跑一轮自主巡检"
echo ""
