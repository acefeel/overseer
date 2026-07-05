---
type: design
date: '2026-07-05'
project: overSeer
tags:
  - design
  - overSeer
  - bug
status: active
title: Design - overSeer 有 23 处 FIXME（9 个文件）
createdAt: '2026-07-05T02:24:13.919Z'
---
## 背景
示例：
  - vault/overSeer/designs/design-overseer-有-28-处-todo12-个文件.md:15 /XXX/HACK/BUG/NOTE 注释聚合 |
  - vault/overSeer/designs/design-overseer-有-28-处-todo12-个文件.md:16 /XXX/HACK/BUG/NOTE 注释扫描（按 tag 聚合） |
  - vault/overSeer/designs/design-overseer-有-28-处-todo12-个文件.md:19 /HACK。挑一个让 codegen 实现。
  - src/scanners/todo.ts:58 'high',
  - src/scanners/todo.ts:77 ' || tag === 'BUG' ? 'bug' : 'tech-debt',

共 23 处。建议归类处理或迁入 issue tracker。

## 建议动作
用 grep 全量列出 FIXME，按文件聚类

## 风险
- 扫描器自动生成，可能误判

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
