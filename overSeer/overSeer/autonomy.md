---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "M4 自主巡检：扫描器 / 队列 / 健康 / 自循环"
tags: [m4, autonomy, scanner, queue, health, schedule]
---

# M4 自主巡检：扫描器 / 队列 / 健康 / 自循环

## 一、五类扫描器（src/scanners/）

| id | 文件 | cost | 干什么 |
|---|---|---|---|
| `git` | `git.ts` | cheap | dirty/untracked/未推送/远端落后/N 天无提交 |
| `todo` | `todo.ts` | cheap | TODO/FIXME/XXX/HACK/BUG/NOTE 注释扫描（按 tag 聚合） |
| `outdated` | `outdated.ts` | medium | `npm outdated --json` → 主版本/次版本过期 |
| `test` | `test.ts` | expensive | 跑 `manifest.testCommand`，失败 → 高优 intention |
| `lint` | — | medium | 占位（M5 实现） |

**激进度配置**（`daemon.autonomy.aggressiveness`）：
- `light` = git + todo
- `normal` = light + outdated
- `full` = normal + test

## 二、意向队列（src/supervisor/queue.ts）

- 持久化到 `data/queue.json`
- **去重键**：`project::source::seed.key`（重扫不增量）
- **老化**：30 天未见且非 pending 的会被 prune
- 排序：severity desc → lastSeen asc
- 字段：`id, dedupe, project, source, category, severity, title, detail, hint, files, status, firstSeen, lastSeen, intentionId`
- 状态机：`pending → plan-generated → design-generated → executing → done | abandoned`

## 三、健康探测（src/providers/health.ts）

- 5 秒超时；60 秒缓存（daemon 启动时刷新一次，之后每 5 分钟后台刷新）
- 只调 `/models`（OpenAI 兼容）/ `/api/tags`（Ollama 风格），**不调 LLM**
- 用于：判断 fallback 是否真实可用（配置 ready ≠ 网络 reachable）

## 四、Autonomy 一轮（src/supervisor/autonomy.ts）

```
闸门: recomputeMode → if mode != normal: 仅记账退出
   ↓
扫描: scanProjects → scanAll(enabled, allowShell, limitPerScanner)
   ↓
入队: queue.enqueue(seeds) → 去重合并 + prune(30d)
   ↓
执行（可选）: if autoExecute && pickNext → pdcae.executeIntention
              ⚠ 仅到 design 阶段；不 --execute
   ↓
审计: data/cycle-log.jsonl 追加一行
```

## 五、Daemon 主循环

```ts
sched = new Scheduler(cfg.daemon.supervisionIntervalMs, async () => {
  await autonomy.runCycle();
}, sup);
sched.start();
setInterval(health.checkAll, 5 * 60_000);
```

默认 `supervisionIntervalMs: 1800000`（30 分钟）+ `autoExecute: false`（只扫描填队列，不真动）。

## 六、安全设计

- **`autoExecute` 只到 design**：跑 design 笔记生成；**永远不**自动跑 develop `--execute`（写代码必须 CLI 显式）
- **degraded/stopped 跳过整个 cycle**：mode != normal 时只记日志退出，不消耗 fallback token 做扫描
- **`allowShellDuringScan` 默认 false**：默认不跑 npm outdated / test（避免误产生副作用）

## 七、CLI 命令

```bash
# 队列
overseer queue list [--project X] [--limit N]
overseer queue stats
overseer queue show <id>
overseer queue drop <id>
overseer queue clear [--project X]
overseer queue pick [--project X]

# 巡检
overseer cycle run [--aggressiveness light|normal|full] [--project X] [--auto-execute] [--allow-shell]
overseer cycle log [--limit N]
overseer cycle scan <project> [--aggressiveness L|N|F] [--allow-shell]

# 健康探测
overseer health
```

## 八、典型启用流程

```bash
# 1. 看初始健康（确认主控 + fallback 都活着）
overseer health

# 2. 手动跑一轮扫描看效果
overseer cycle run --aggressiveness normal
overseer queue list
overseer queue stats

# 3. 挑一个高优 intention 落 design 笔记
overseer queue pick
overseer supervise develop <intentionId>

# 4. 真改代码（项目需 allowWrite=true）
overseer supervise develop <intentionId> --execute

# 5. 启动 daemon 自循环（30 分钟一轮）
overseer daemon start
overseer cycle log --limit 5
```

## 九、相关

- [[overSeer/knowledge/budget-model]]
- [[overSeer/knowledge/memory-judge]]
- [[overSeer/degraded-mode]]
- [[overSeer/pdcae-supervision]]
