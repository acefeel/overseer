# overSeer

> 一个有预算意识的开发监理 agent。常驻 daemon + CLI；用 GLM-5.2 等 Coding API 执行 (计划-设计-开发-测试-评估) 循环；自主维护一个 Obsidian 知识库；监控自己的 token 消耗，逼近上限就休息。

## 快速开始

```bash
# 1. 装依赖
npm install

# 2. 配置密钥（二选一）
copy config\.secrets.example.yaml config\.secrets.yaml
#   然后编辑 .secrets.yaml，填 providers.glm.apiKey
# 或：
set OVERSEER_GLM_API_KEY=你的key

# 3. 看看状态（无需 daemon 也能跑）
npm run dev -- status

# 4. 聊一句
npm run dev -- chat "你是谁？"

# 5. 启动常驻 daemon
npm run dev -- daemon start
npm run dev -- daemon status
```

构建后可以直接用：

```bash
npm run build
node dist\cli\index.js status
```

## 核心能力

| 能力 | 命令 | 状态 |
|---|---|---|
| 多 provider 路由（GLM-5.2 起步，可加 Anthropic/OpenAI） | 内置 | ✅ M1 |
| Token ledger + 预算策略（"快没钱了就休息"） | `overseer status` | ✅ M1 |
| CLI 聊天（daemon 在线优先，离线降级本地） | `overseer chat` | ✅ M1 |
| 常驻 daemon + IPC（Windows named pipe / Unix socket） | `overseer daemon ...` | ✅ M1 |
| Obsidian 知识库自动写入 + 检索 | `overseer kb`（待） | ☐ M2 |
| PDCAE 监理循环（计划-设计-开发-测试-评估） | 待 | ☐ M3 |
| 自主巡检 + 意向队列 + git 快照/回滚 | 待 | ☐ M4 |

## 知识库

`vault/` 是统一 Obsidian vault，可以直接用 Obsidian 打开。结构见 [`vault/INDEX.md`](vault/INDEX.md)。

## 配置

详见 [`AGENTS.md`](AGENTS.md) §4。简而言之：

- `config/overseer.config.yaml` —— 主配置
- `config/.secrets.yaml` —— 密钥（不入库）
- 环境变量 `OVERSEER_<PROVIDER>_API_KEY`

## 安全设计

- M1~M2 默认 `dry-run`，只产出 vault 笔记和计划，不动代码。
- 高危动作（push / 删未追踪文件 / 跨项目改动）需 CLI 显式批准。
- 所有 provider 调用进 `data/token-ledger.jsonl` 可审计。

## 开发

```bash
npm run typecheck
npm test
```

技术栈：TypeScript (ESM) + Node 24 + commander + pino + zod + yaml + simple-git。
