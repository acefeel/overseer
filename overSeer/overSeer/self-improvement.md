---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "Self-Improvement：让 overSeer 改进自己"
tags: [self-improve, codegen, safety, m4]
---

# Self-Improvement：让 overSeer 改进自己

overSeer 可以把自己当作被监理的项目之一来改进。这是项目的终极目标，但**也是最高风险的场景**——一个坏改动可能让 agent 自己跑不起来。所以全套安全机制必须到位。

## 一、完整工作流

```bash
# 0. 前置：必须有主控 provider（degraded 永远不能写代码）
# 编辑 config/.secrets.yaml 填 GLM key

# 1. 把 overSeer 自己设为可写项目
overseer projects init overSeer --allow-write --test "npm run typecheck"

# 2. 扫描自己，找改进点（git/todo/outdated）
overseer cycle run --aggressiveness normal --project overSeer

# 3. 看候选意向
overseer queue list --project overSeer

# 4. 选一个，先看 design 草案（不动代码）
overseer supervise develop <id>

# 5. 真改代码（每文件前自动 snapshot）
overseer supervise develop <id> --execute

# 6. 不满意？撤回
overseer supervise snapshots
overseer supervise rollback <snapId>
```

## 二、四层安全（按优先级）

### ① Mode Gate（最强）
- `mode != normal` → 直接拒绝任何写动作
- **包括 degraded**（即使本地 fallback 在线，也不能改代码）
- 这意味着**没有主控 key 就无法 self-improve**，是设计约束

### ② Manifest Gate
- `allowWrite=false` → 拒绝
- `protectedPaths` 默认包含：
  - `config/**` / `.secrets.*` —— 不能改自己的配置/密钥
  - `data/**` / `logs/**` —— 不能污染自己的状态
  - `vault/**` / `.obsidian/**` —— 不能篡改自己的记忆
  - `dist/**` / `node_modules/**` / `package-lock.json` —— 不能改构建产物
- codegen 产出命中这些路径的改动会被自动拒绝并记录

### ③ Codegen 硬约束
- 单次最多改 5 个文件
- 单次总改动 < 30KB
- modify 必须输出整文件（不是 diff）
- delete 走 approvals 高危队列，不自动执行

### ④ Snapshot + Auto-rollback
- 每个 file.write 前自动 `git stash + tag overseer/snap/<id>`
- 如果 manifest 配了 `testCommand` 且改动后测试失败 → 自动 rollback 到 snapshot
- 永远可以手动 `overseer supervise rollback <snapId>`

## 三、关键文件

| 文件 | 作用 |
|---|---|
| `src/supervisor/codegen.ts` | LLM 产出 `FileChange[]` + parseAndFilter 安全过滤 |
| `src/supervisor/loop.ts` `develop()` | 编排：codegen → 逐个 ActionExecutor.writeFile → 可选 test → retro 笔记 |
| `src/supervisor/actions.ts` `writeFile()` | 三道闸门 + protectedPaths 检查 + snapshot |
| `src/projects/manifest.ts` | `protectedPaths` 配置 |
| `src/util/glob.ts` | 极简 glob 匹配（`**` / `*`） |

## 四、什么改不动（永远）

按设计，overSeer 不能通过 self-improvement 改：

- 它自己的 `.secrets.yaml`（key）
- 它自己的 `config/overseer.config.yaml`（包括 budget、protectedPaths 本身）
- 它自己的 `data/` 状态（token-ledger / queue / approvals / snapshots / intentions）
- 它自己的 vault 记忆（防止"洗脑"）

要改这些，必须人工编辑。这是底层不变式。

## 五、典型首轮改进（建议）

从低风险高价值的开始：

1. **修 TODO 注释**：扫描器已经找到 overSeer 自己代码里的 TODO/FIXME/HACK。挑一个让 codegen 实现。
2. **补测试**：`tests/` 目录现在只有 smoke 测试，可以让 codegen 给关键模块（如 mode.ts、queue.ts）补单元测试。
3. **改文档**：让 codegen 根据代码实际行为更新 README/AGENTS.md（注意：vault 不让改，但根目录的 md 可以）。
4. **小重构**：抽取重复逻辑、改善命名。

避免：
- 改 PDCAE loop 本身（容易自我放大）
- 改 ModePolicy / ActionExecutor（安全核心）
- 改 provider 抽象（容易断链）

## 六、相关

- [[overSeer/pdcae-supervision]]
- [[overSeer/degraded-mode]]
- [[overSeer/autonomy]]
- [[overSeer/decisions/stack-typescript-esm]]
