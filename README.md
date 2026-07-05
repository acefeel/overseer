# overSeer

> 一个有预算意识的开发监理 agent。常驻 daemon + CLI + TUI；用 GLM-5.2 等 Coding API 执行 (计划-设计-开发-测试-评估) 循环；自主维护一个 Obsidian 知识库；监控自己的 token 消耗，逼近上限就休息。

## 快速开始

### 一键安装（推荐）

Windows：
```bash
.\scripts\install.bat
```

macOS / Linux：
```bash
bash scripts/install.sh
```

脚本会检查 Node.js >= 20、git、安装依赖、创建 `data/` `logs/`、生成 `.secrets.yaml` 模板，并运行 `overseer doctor`。

### 手动安装

```bash
npm install

# 配置密钥（二选一）
copy config\.secrets.example.yaml config\.secrets.yaml
#   然后编辑 .secrets.yaml，填 providers.glm.apiKey
# 或：
set OVERSEER_GLM_API_KEY=你的key      # Windows
export OVERSEER_GLM_API_KEY=你的key   # macOS/Linux

# 自检
npm run dev -- doctor

# 看看状态
npm run dev -- status

# 聊一句
npm run dev -- chat "你是谁？"

# 启动常驻 daemon
npm run dev -- daemon start
npm run dev -- daemon status
```

构建后可以直接用：

```bash
npm run build
node dist\cli\index.js status
# 或
npx overseer status
```

## 核心能力

| 能力 | 命令 | 状态 |
|---|---|---|
| 多 provider 路由（GLM-5.2 / OpenAI / Anthropic / 本地 Ollama） | 内置 | ✅ M1 |
| Token ledger + 预算策略（"快没钱了就休息"） | `overseer status` | ✅ M1 |
| CLI 聊天（daemon 在线优先，离线降级本地） | `overseer chat` | ✅ M1 |
| 常驻 daemon + IPC（Windows named pipe / Unix socket） | `overseer daemon ...` | ✅ M1 |
| 自检与首次安装引导 | `overseer doctor` / `scripts/install.*` | ✅ M1 |
| Obsidian 知识库自动写入 + 图检索 | `overseer kb ...` | ✅ M2 |
| PDCAE 监理循环（计划-设计-开发-测试-评估） | `overseer supervise ...` | ✅ M3 |
| 自主巡检 + 意向队列 + git 快照/回滚 | `overseer cycle ...` | ✅ M4/M5 |
| 全屏 TUI 控制台 | `overseer tui` | ✅ M5 |

## 常用命令

```bash
overseer status                  # 健康/预算/provider/模式
overseer doctor                  # 自检并给出修复建议
overseer chat [message]          # 聊天 / REPL
overseer tui                     # 全屏 dashboard

overseer daemon start            # 启动常驻 daemon
overseer daemon status           # 查看 daemon
overseer daemon stop             # 停止

overseer projects list           # 查看工作区项目
overseer projects init overSeer --allow-write --test "npm test"

overseer cycle run               # 跑一轮自主巡检
overseer queue list              # 查看队列

overseer supervise plan overSeer # 生成项目意向
overseer supervise approvals     # 查看待审批
```

## 配置

详见 [`AGENTS.md`](AGENTS.md)。简而言之：

- `config/overseer.config.yaml` —— 主配置（可入库）
- `config/overseer.config.local.yaml` —— 本地覆盖（gitignored）
- `config/.secrets.yaml` —— 密钥（gitignored）
- 环境变量 `OVERSEER_<PROVIDER>_API_KEY` 优先级最高

最小可用配置：

```bash
# Windows
set OVERSEER_GLM_API_KEY=你的key

# macOS/Linux
export OVERSEER_GLM_API_KEY=你的key
```

或不设 key，只启用本地 fallback（需 Ollama 运行）：

```yaml
providers:
  local:
    enabled: true
    kind: local
    role: fallback
    baseUrl: http://localhost:11434/v1
    apiKey: "ollama"
    model: gemma4:latest
```

## 安全设计

- 默认 `allowWrite=false`，overSeer 只读监理，任何写代码动作都会被拒绝。
- 高危动作（`git.push` / `file.delete` / `shell.exec` 等）需要 `overseer supervise approve <id>` 显式批准。
- 每次写文件 / shell exec / git commit 前自动打 git snapshot，失败可 `overseer supervise rollback <id>`。
- 受保护路径：`.secrets.*`、`config/`、`data/`、`logs/`、`vault/`、`dist/`、`node_modules/`、`package-lock.json` 等默认不可改。
- 所有 provider 调用进 `data/token-ledger.jsonl` 与 `data/provider-metrics.jsonl` 可审计。

## 知识库

`vault/` 是统一 Obsidian vault，可以直接用 Obsidian 打开。结构见 [`vault/INDEX.md`](vault/INDEX.md)。

自动写入的笔记类型：

- `chat_log` —— 每次对话审计
- `daily` —— 当日索引
- `budget` —— 模式切换、预算事件
- `plan/design/retro` —— PDCAE 循环产物
- `knowledge` —— provider 事件、队列事件等运行时沉淀

## 开发

```bash
npm run typecheck
npm test
npm run build
```

技术栈：TypeScript (ESM) + Node >= 20 + commander + pino + zod + yaml + simple-git + ink + react。

## License

MIT
