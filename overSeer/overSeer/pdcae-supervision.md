---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "PDCAE 监理循环 + Git Snapshot/Rollback"
tags: [pdcae, git, snapshot, rollback, supervise, m3]
---

# PDCAE 监理循环 + Git Snapshot/Rollback

## 一、PDCAE 五阶段（M3 实现）

| 阶段 | 实现 | 输出 |
|---|---|---|
| **P**lan | `IntentionGenerator.generate()` 调 LLM 产出候选意向 | `<project>/plans/` + `data/intentions.json` |
| **D**esign | `PdcaeLoop.executeIntention()` 把意向落成具体方案笔记 | `<project>/designs/` |
| **D**evelop | `ActionExecutor.writeFile / runShell / gitCommit` 真改代码 | 工作树变化 + git commit |
| **T**est | `ProjectManifest.testCommand` 通过 `ActionExecutor.runShell` 执行 | shell exit code |
| **E**valuate | `PdcaeLoop.develop()` 末尾自动写 retro | `<project>/retros/` |

**M3 阶段的安全策略**：Develop 默认**不会自动执行**。即便项目 `allowWrite=true`，跑 PDCAE 默认只到 Design 阶段（产出方案笔记）。要真改代码必须显式 `overseer supervise develop <id> --execute`。

## 二、Git Snapshot 机制

每次有副作用动作（write/exec/commit）前，`Snapshotter.take()` 自动：

1. 检测 working tree 是否 dirty
2. dirty → `git stash push -u` 暂存用户 WIP（含 untracked）
3. 给当前 HEAD 打 lightweight tag：`overseer/snap/<id>`
4. 写 manifest 到 `data/snapshots/<id>.json`：`{branch, headSha, hadDirty, stashed, tag, reason, ts}`

`id` 格式：`YYYYMMDDhhmmss-xxxx`（4 位随机后缀）。

## 三、Rollback 机制

`Rollback.to(snapId)` 反向操作：

1. `git reset --hard overseer/snap/<id>` —— 把 overSeer 的 commits 全部撤销
2. 如果当时 stash 过 → `git stash pop` —— 恢复用户 WIP
3. 删 manifest 文件

**只影响 overSeer 自己的提交**。用户的预存改动被 stash 保护，回滚后完整还原。

## 四、三道闸门（ActionExecutor.gate）

所有有副作用动作按顺序过：

1. **ModePolicy.canPerform(action, mode)** —— degraded/stopped 直接拒
2. **ProjectManifest.allowWrite / allowExec** —— per-project 白名单
3. **Approvals** —— 高危动作（`git.push` / `file.delete` / `shell.exec` 未白名单）挂起，等 CLI `overseer supervise approve <id>`

## 五、典型工作流

```bash
# 1. 先看工作区有哪些项目
overseer projects list

# 2. 给某个项目装 manifest（默认 read-only）
overseer projects init aaws
#   真要让 overSeer 改代码：overseer projects init aaws --allow-write --test "npm test"

# 3. 生成改进意向（Plan 阶段）
overseer supervise plan aaws "重点看 PLC 协议层有没有边界 bug"

# 4. 看候选
overseer supervise intentions aaws
overseer supervise intention <id>

# 5. 把某个意向落成 design 笔记（仍不改代码）
overseer supervise develop <id>

# 6. 想真改代码（需要项目 allowWrite=true）
overseer supervise develop <id> --execute

# 7. 看快照、必要时回滚
overseer supervise snapshots
overseer supervise rollback <snapshotId>

# 8. 处理高危动作审批
overseer supervise approvals
overseer supervise approve <approvalId>
overseer supervise reject <approvalId>
```

## 六、关键约束（踩坑预警）

- **JHAVSP 这种只有 `docs/` 的目录默认不被检测**。要管它：`overseer projects init JHAVSP`（接受路径）。
- **没有 git 的项目**：snapshot 退化为只记 manifest，rollback 是 no-op；写文件仍受 `allowWrite` 约束。
- **detached HEAD**：snapshot 用 HEAD sha，rollback 用 sha 直接 reset。
- **stash 冲突**：rollback 时若 `git stash pop` 冲突，warn 不致命，提示用户 `git stash list` 手动处理。

## 七、相关

- [[overSeer/knowledge/budget-model]]
- [[overSeer/knowledge/memory-judge]]
- [[overSeer/degraded-mode]]
- [[overSeer/decisions/stack-typescript-esm]]
