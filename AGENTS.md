# overSeer 项目 Agent 操作备忘

> 每次进入本目录工作时必读。记录组件边界、构建运行方式、代码约定、安全策略和当前已知的实现不一致之处。

---

## 1. 项目定位

`overSeer` 是一个常驻型、带预算意识的"开发监理 agent"。

- **CLI + daemon 双入口**：日常命令走 `overseer <cmd>`，后台常驻 daemon 负责定时巡检和任务循环。
- **LLM 驱动**：默认主链接入智谱 GLM-5.2（OpenAI 兼容协议），并支持本地 Ollama/LM Studio 作为 fallback/worker。
- **PDCAE 循环**：对 workspace 中的项目执行 Plan → Design → Develop → Test → Evaluate 监理循环。
- **Obsidian 知识库**：所有决策、计划、设计、预算审计、聊天记录自动沉淀到 `vault/`。
- **自我保护**：token 预算、模式降级、快照回滚、审批闸门、受保护路径共同限制副作用半径。

---

## 2. 技术栈

| 层级 | 技术 |
|---|---|
| 运行时 | Node.js ≥20（推荐 22/24） |
| 语言 | TypeScript 5.7，ESM（`"type": "module"`） |
| 编译 | `tsc` 输出到 `dist/`，启用 `NodeNext` 模块解析 |
| CLI 框架 | commander |
| 配置校验 | zod + yaml |
| 日志 | pino + pino-pretty |
| Git 操作 | simple-git |
| TUI | ink + react |
| 测试框架 | vitest（当前仓库无 `.test.ts` 文件）；实际可运行测试在 `tests/*.mjs` |

---

## 3. 目录结构

```
config/
  overseer.config.yaml      # 主配置（可入库）
  .secrets.example.yaml     # 密钥模板
  .secrets.yaml             # 真实密钥（gitignored）
src/
  cli/                      # commander 入口 + 各子命令
  daemon/                   # 常驻 daemon：launcher、ipc、supervisor、mode、taskloop
  providers/                # Provider 抽象、GlmProvider、OpenAI 兼容实现、Router、HealthProbe
  budget/                   # TokenTracker + BudgetPolicy
  kb/                       # Vault 读写、检索、MemoryJudge
  projects/                 # workspace 扫描、.overseer.json manifest
  scanners/                 # git / todo / outdated / test 扫描器
  supervisor/               # PDCAE loop、ActionExecutor、 approvals、queue、autonomy、consultant
  vcs/                      # ProjectGit、Snapshotter、Rollback
  util/                     # logger、paths、config、glob
  tui/                      # ink 全屏 dashboard
tests/
  *.mjs                     # 烟雾测试（依赖 dist/，部分需要 daemon/API key）
  *.test.ts                 # vitest 单元测试
vault/                      # Obsidian 知识库根
data/                       # 运行时状态（gitignored）
logs/                       # pino 日志（gitignored）
dist/                       # tsc 产物（gitignored）
```

---

## 4. 构建与运行命令

```bash
# 安装依赖
npm install

# 类型检查（不产物）
npm run typecheck

# 构建到 dist/
npm run build

# 直接跑 CLI（dev 模式，用 tsx）
npm run dev -- status
npm run dev -- chat "你好"

# 直接跑 daemon（前台，dev 模式）
npm run start:daemon

# 直接跑 TUI
npm run start:tui

# 运行 vitest
npm test

# 烟雾测试（需要先 build）
node tests/vcs-smoke.mjs       # 快照/回滚（无需 API key）
node tests/mode-smoke.mjs      # ModePolicy + Router（无需 API key）
node tests/autonomy-smoke.mjs  # 扫描 + 队列入队/去重/pick（无需 API key）
node tests/codegen-smoke.mjs   # codegen 解析与过滤（无需 API key）
node tests/launcher-smoke.mjs  # daemon 启动/IPC/关闭（无需 API key）
node tests/ipc-smoke.mjs       # 需要 daemon 正在运行
node tests/shutdown-smoke.mjs  # 需要 daemon 正在运行
```

### 4.1 构建产物说明

- `dist/` 由 `tsc` 生成，保留 `.js` 扩展名。因为源码是 ESM，所有相对导入都已带 `.js` 后缀。
- 烟雾测试直接 `import '../dist/.../foo.js'`，所以修改源码后必须重新 `npm run build` 再跑烟雾测试。

---

## 5. 配置与密钥

### 5.1 文件层级

| 文件 | 作用 | 是否入库 |
|---|---|---|
| `config/overseer.config.yaml` | 主配置 | 是 |
| `config/overseer.config.local.yaml` | 本地覆盖 | 否（gitignored） |
| `config/.secrets.yaml` | API key 等密钥 | 否（gitignored） |
| 环境变量 `OVERSEER_<PROVIDER>_API_KEY` | 最高优先级密钥 | — |

### 5.2 优先级

配置合并顺序（后者覆盖前者）：

1. `overseer.config.yaml`
2. `overseer.config.local.yaml`
3. `.secrets.yaml`
4. 环境变量 `OVERSEER_<PROVIDER>_API_KEY`

### 5.3 最小可用配置

复制模板并填 key：

```bash
copy config\.secrets.example.yaml config\.secrets.yaml
# 编辑 .secrets.yaml 填 providers.glm.apiKey
```

或仅设环境变量：

```bash
set OVERSEER_GLM_API_KEY=你的key
```

本地 fallback（Ollama）默认启用，不需要 key：

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

---

## 6. Provider 架构

### 6.1 Provider 接口

`src/providers/base.ts` 定义统一接口：

```typescript
interface Provider {
  id: string;
  kind: string;
  role: 'main' | 'fallback';
  canAct: boolean;
  isReady(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(messages, model?): Promise<number>;
  fetchQuota?(): Promise<QuotaStatus>;
}
```

### 6.2 Provider 种类

| kind | 用途 | 角色 |
|---|---|---|
| `glm` | 智谱开放平台 / Coding Plan | main |
| `openai` / `deepseek` / `anthropic` | OpenAI 兼容远程服务 | main |
| `local` | Ollama / LM Studio 等本地模型 | fallback |

所有 `openai`/`deepseek`/`anthropic`/`local` 目前共用 `OpenAICompatProvider`（OpenAI 兼容协议）。

### 6.3 Router 与 M5 的 worker/consultant 抽象

`Router` 在 `src/providers/router.ts` 中：

- `activeChain`：主链，按顺序 failover。
- `fallbackProviderId`：配置中 `router.fallback` 对应的 fallback provider。
- `getWorkerProvider()`：优先 fallback（本地，省钱），其次主链。**M5 新增**。
- `getConsultantProvider()`：优先主链（能力更强），其次 fallback。**M5 新增**。
- `chatViaWorker()` / `chatViaConsultant()`：**M5 新增**。

### 6.4 HealthProbe

`src/providers/health.ts` 不调 LLM，只 ping `/models`（OpenAI 兼容）或 `/api/tags`（Ollama）。daemon 启动时刷新一次，之后每 5 分钟后台刷新。

---

## 7. Token 预算

### 7.1 Ledger

每次 provider 调用追加一行 JSON 到 `data/token-ledger.jsonl`。

### 7.2 BudgetPolicy

`src/budget/policy.ts`：

- 按日/周滚动窗口统计用量。
- 输出 `level`：`ok` → `caution` → `low` → `exhausted`。
- 输出 `recommendation`：`continue` → `small_tasks_only` → `pause` → `stop`。
- `canRunTask(estimatedTokens)`：在 LLM 任务前做闸门，超过 `perTaskEstimateCap` 或逼近安全垫直接拒绝。

### 7.3 预算相关配置项

```yaml
budget:
  dailyLimitTokens: 5000000
  weeklyLimitTokens: 35000000
  safetyPadTokens: 200000
  perTaskEstimateCap: 800000
```

---

## 8. 监理模式（normal / degraded / stopped）

`src/daemon/mode.ts` 中的 `ModePolicy` 决定当前模式：

| 模式 | 触发条件 | 行为 |
|---|---|---|
| `normal` | 主链可用 AND 预算 `ok/caution` | 主控 provider 全权处理 |
| `degraded` | 主链不可用 OR 预算 `low/exhausted`，且 fallback 可用 | 切本地 fallback（worker 模式）。动作仍受 `ProjectManifest`、`protectedPaths`、自动 snapshot、approvals 约束 |
| `stopped` | 主链不可用且没有 fallback；或预算耗尽且无 fallback | 拒绝 LLM 调用，仅保留 IPC/状态查询 |

### 8.1 M5 设计说明：degraded 模式不是“只读”

从 M5 开始，`degraded` 模式的安全策略由“mode 层一刀切禁止”改为“mode 层放行 + 后续闸门兜底”。

- `ModePolicy.canPerform(action, 'degraded')` 对所有动作返回 `ok=true`。
- `OpenAICompatProvider.canAct` 保持 `true`，使本地 fallback 可以作为 worker 执行有副作用动作。
- 实际写/删/执行动作时，依次经过：
  1. `ProjectManifest.allowWrite` / `allowExec` / `protectedPaths`
  2. `ActionExecutor` 的自动 `Snapshotter.take()`
  3. `Approvals` 审批（高危动作）

因此文档、注释、banner 中的 "read-only / 禁止写删执行" 描述已被移除。Agent 编码时不应再依赖旧假设。

---

## 9. 任务循环与自主巡检（M4/M5）

### 9.1 TaskLoop（M5 替代旧 Scheduler）

`src/daemon/taskloop.ts`：

- daemon 启动后持续运行，tick 间隔 1.5 秒。
- 状态机：`idle / running / scanning / consulting / resting / paused / error`。
- 循环逻辑：
  1. 取 queue 中 pending 项，调用 `PdcaeLoop.executeQueueItem()`。
  2. 若执行失败/回滚，升级到 `Consultant.escalate()`。
  3. queue 空时，扫描各项目；若无新种子，则询问 `Consultant.reviewProject()` 是否到达 milestone。
  4. 全部项目到达 milestone → 进入 `resting`，等待用户 chat 或其他外部事件唤醒。

### 9.2 Consultant（M5 新增）

`src/supervisor/consultant.ts`：

- `reviewProject(project)`：判断项目是否到达 milestone，否则给出新的改进建议并入队。
- `escalate(project, task, blockReason)`：worker 卡住时请求具体解决方案。

### 9.3 Autonomy（CLI 触发的一轮巡检）

`src/supervisor/autonomy.ts`：

- `cycle run` 会扫描项目、入队、可选自动执行队列顶项到 design 阶段。
- 扫描器按 `aggressiveness` 启用：
  - `light`：`git` + `todo`
  - `normal`：再加 `outdated`
  - `full`：再加 `test`
- `allowShellDuringScan` 为 false 时，需要 spawn 的 scanner（`outdated`、`test`）会被跳过。
- `autoExecute` 只在 `mode=normal` 时真正调 LLM 跑 design，**不会自动 `--execute` 写代码**。

### 9.4 Queue

`src/supervisor/queue.ts`：

- 持久化在 `data/queue.json`。
- 去重键：`project::source::key`。
- 排序：severity desc → lastSeen asc。
- 30 天老化清理（`prune(30)`）。
- 状态：`pending → plan-generated → design-generated → executing → done | abandoned`。

---

## 10. PDCAE 监理循环

`src/supervisor/loop.ts` 中的 `PdcaeLoop`：

### 10.1 Plan

`overseer supervise plan <project> [hint]`：

- 调用 `IntentionGenerator` 生成候选意向。
- 写入 `data/intentions.json`。
- 生成 `plan` 类型 vault 笔记。

### 10.2 Design

`overseer supervise develop <intentionId>`（不带 `--execute`）：

- 默认只生成 design 笔记，不改代码。
- 若项目 `allowWrite=false`，同样只生成 design。

### 10.3 Develop / Execute

`overseer supervise develop <intentionId> --execute`：

- 调用 `CodeChangeGenerator` 产出代码改动。
- 每个文件写入前自动 `Snapshotter.take()`。
- 写入后若 manifest 配置了 `testCommand`，自动跑测试；失败则自动 rollback 到第一个 snapshot。
- 删除操作需要 approval。

### 10.4 Snapshot / Rollback

`src/vcs/snapshot.ts` 与 `src/vcs/rollback.ts`：

- 快照：dirty 时先 `git stash push -u`，再对 HEAD 打 lightweight tag `overseer/snap/<id>`，manifest 写入 `data/snapshots/<id>.json`。
- 回滚：`git reset --hard overseer/snap/<id>`，若当时 stash 过则 `git stash pop`，并删除 snapshot manifest。
- **只影响 overSeer 自己的 commits；用户 WIP 被 stash 保护。**

---

## 11. 项目与 Manifest

### 11.1 自动检测

`src/projects/scanner.ts` 扫描 `workspace.root`（默认 `..`，即 `E:\codeSpace`）的直接子目录。满足以下任一条件即视为项目：

- 存在 `.git`
- 存在 `package.json`
- 存在 `AGENTS.md`
- 存在 `.overseer.json`（manifest）

### 11.2 Project Manifest

每个项目根目录可放置 `.overseer.json`，由 `src/projects/manifest.ts` 解析：

```json
{
  "version": 1,
  "allowWrite": false,
  "allowExec": ["npm test", "npm run build"],
  "requiresApproval": ["git.push", "file.delete", "shell.exec"],
  "mainBranch": "main",
  "testCommand": "npm test",
  "protectedPaths": ["config/**", ".secrets.*", "data/**", "logs/**", "vault/**", ".obsidian/**", "dist/**", "node_modules/**", "*.pid", "package-lock.json"],
  "notes": ""
}
```

关键字段：

- `allowWrite=false`：overSeer 只读监理，任何写代码动作都会被拒绝。
- `allowExec`：允许自动执行的 shell 命令前缀白名单。
- `protectedPaths`：glob 列表，覆盖这些路径的改动会被 `ActionExecutor` 拒绝（防止自残）。

### 11.3 CLI

```bash
overseer projects list
overseer projects show <id>
overseer projects init <id> [--allow-write] [--test "cmd"]
overseer projects status <id>
```

---

## 12. 扫描器

`src/scanners/`：

| id | 成本 | 触发条件 | 说明 |
|---|---|---|---|
| `git` | cheap | 任何模式 | 未提交/未推送/远端落后/N 天无提交 |
| `todo` | cheap | 任何模式 | TODO/FIXME/XXX/HACK/BUG/NOTE 注释聚合 |
| `outdated` | medium | `normal` + `allowShell=true` | `npm outdated` 主/次版本 |
| `test` | expensive | `full` + `allowShell=true` | 跑 manifest.testCommand |
| `lint` | medium | `normal` + `allowShell=true` | 检测 eslint/stylelint/prettier 配置并尝试运行 lint |

`src/scanners/index.ts` 中的 `scanAll()` 串行扫描每个项目。

---

## 13. 知识库（Vault）

### 13.1 目录映射

`src/kb/schema.ts`：

| type | 目录 |
|---|---|
| `moc` | `vault/INDEX.md` |
| `daily` | `vault/overSeer/daily/` |
| `adr` | `vault/overSeer/decisions/` |
| `budget` | `vault/overSeer/budgets/` |
| `plan` | `vault/<project>/plans/` |
| `design` | `vault/<project>/designs/` |
| `retro` | `vault/<project>/retros/` |
| `knowledge` | `vault/<project>/` |
| `chat_log` | `vault/overSeer/chat-logs/` |

### 13.2 写入

`VaultWriter.write()` 用 gray-matter 生成带 frontmatter 的 Markdown。`MemoryJudge` 在每次 chat 后判断是否值得写笔记（temperature 0.1，maxTokens 800）。

### 13.3 检索

`VaultRetriever.search()`：

- 纯 JS 实现，无外部搜索引擎。
- tokenizer：ASCII 词 + CJK 单字/双字组合，去停用词。
- 权重：标题/frontmatter/tag 命中 ×5，正文命中 ×2。
- chat 时自动注入 top-5 命中到 system prompt。

### 13.4 Obsidian 配置

`vault/.obsidian/` 预置了核心插件与社区插件声明（dataview / templater / calendar / checklist）。**社区插件本体需 Obsidian 自行下载。**

---

## 14. 审批系统

`src/supervisor/approvals.ts`：

- 高危动作（`git.push`、`file.delete`、`shell.exec` 等）会创建 pending approval。
- 数据持久化在 `data/approvals.json`。
- CLI：`overseer supervise approvals`、`overseer supervise approve <id>`、`overseer supervise reject <id>`。

---

## 15. IPC 协议

`src/daemon/ipc.ts`：

- Windows：`\\.\pipe\overseer`
- Unix：`/tmp/overseer.sock`
- 协议：每行一个 JSON，`{ id, op, payload? }` → `{ id, ok, data?, error? }`。

当前 ops：

| op | 说明 |
|---|---|
| `ping` | 心跳 |
| `status` | 完整状态（providers、mode、budget、taskLoop、vaultNotes） |
| `chat` | 聊天 |
| `kb.search` | 知识库检索 |
| `kb.recent` | 最近笔记 |
| `taskloop.state` | TaskLoop 快照 |
| `taskloop.pause` | 暂停任务循环 |
| `taskloop.resume` | 恢复任务循环 |
| `reset` | 清空 chat history |
| `shutdown` | 关闭 daemon |

---

## 16. CLI 命令速查

```bash
overseer status                              # 状态面板
overseer chat [message]                      # 聊天 / REPL
overseer tui                                 # 全屏 dashboard

overseer daemon <start|stop|restart|status>  # daemon 管理

overseer kb search <q>
overseer kb show <relpath>
overseer kb recent [--type T] [--limit N]
overseer kb write --type T --title "..." --body "..."
overseer kb stats

overseer projects list
overseer projects show <id>
overseer projects init <id> [--allow-write] [--test "cmd"]
overseer projects status <id>

overseer supervise plan <project> [hint]
overseer supervise intentions [project]
overseer supervise intention <id>
overseer supervise develop <id> [--execute]
overseer supervise snapshots
overseer supervise snapshot <id>
overseer supervise rollback <id>
overseer supervise approvals
overseer supervise approve <id>
overseer supervise reject <id>

overseer queue list [--project X] [--limit N]
overseer queue stats
overseer queue show <id>
overseer queue drop <id>
overseer queue clear [--project X]
overseer queue pick [--project X]

overseer cycle run [--aggressiveness light|normal|full] [--project X] [--auto-execute] [--allow-shell]
overseer cycle log [--limit N]
overseer cycle scan <project> [--aggressiveness light|normal|full] [--allow-shell]

overseer health                              # provider 可达性探测
```

---

## 17. 代码风格与约定

1. **ESM 唯一**：`"type": "module"`。业务代码禁止 `require()`，统一用 `import`。
2. **相对导入必须带 `.js` 后缀**，即使源文件是 `.ts`。例如：`import { foo } from './bar.js'`。
3. **路径**：统一用 `node:path`，Windows 兼容由 Node.js 处理。
4. **日志**：用 `getLogger('scope')`，禁止 `console.log`（CLI 用户输出层除外）。
5. **配置读取**：统一走 `loadConfig()`（带缓存），需要刷新时传 `{ force: true }`。
6. **状态文件**：统一放在 `data/` 下，用 `PATHS` 常量。
7. **错误处理**：provider 错误统一抛 `ProviderError`。
8. **JSON 解析**：对可能损坏的文件使用 try/catch，避免整个进程崩溃。

---

## 18. 测试策略

- **单元测试**：`tests/*.test.ts` 由 vitest 运行，覆盖 mode、budget、codegen、queue、approvals 等纯逻辑。
- **烟雾测试**：`tests/*.mjs` 是实际可运行的测试，覆盖：
  - VCS snapshot/rollback
  - ModePolicy 与 Router fallback
  - 扫描器与队列
  - Codegen 解析与过滤
  - daemon launcher / IPC / shutdown
- 烟雾测试依赖 `dist/`，修改源码后需重新 `npm run build`。
- 部分测试需要 daemon 正在运行或配置有效 API key。

---

## 19. 安全边界

1. **默认只读**：`actions.defaultMode = dry-run`，`ProjectManifest.allowWrite` 默认为 `false`。
2. **三道闸门**：
   - `ModePolicy.canPerform(action, mode)`
   - `ProjectManifest.allowWrite / allowExec / protectedPaths`
   - `Approvals` 审批（高危动作）
3. **自动快照**：每个写文件 / shell exec / git commit 前自动 `Snapshotter.take()`，失败可 rollback。
4. **受保护路径**：manifest 默认保护 `config/`、`data/`、`logs/`、`vault/`、`dist/`、`node_modules/`、`package-lock.json`、`.secrets.*`、PID 文件等。
5. **密钥管理**：API key 只从环境变量或 `.secrets.yaml` 读取，**永不写入主配置、不进 git**。
6. **降级模式注意**：M5 起 degraded 模式不再在 mode 层禁止写/删/执行。fallback provider 的 `canAct=true`，实际副作用动作仍受 `ProjectManifest`、`protectedPaths`、自动 snapshot、approvals 约束。

---

## 20. 已知问题与实现不一致

（当前无已知的实现不一致。HealthProbe 模型列表解析已统一。）

---

## 21. 快速启动检查清单

- [ ] `npm install`
- [ ] 配置 API key（`.secrets.yaml` 或环境变量）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build`
- [ ] `npm run dev -- status` 能看到 providers/mode/budget
- [ ] 可选：`npm run dev -- daemon start`
