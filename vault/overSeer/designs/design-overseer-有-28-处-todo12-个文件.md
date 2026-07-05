---
type: design
date: '2026-07-05'
project: overSeer
tags:
  - design
  - overSeer
  - tech-debt
status: active
title: Design - overSeer 有 28 处 TODO（12 个文件）
createdAt: '2026-07-05T02:20:43.331Z'
---
## 背景
示例：
  - AGENTS.md:389 /FIXME/XXX/HACK/BUG/NOTE 注释聚合 |
  - vault/overSeer/autonomy.md:17 /FIXME/XXX/HACK/BUG/NOTE 注释扫描（按 tag 聚合） |
  - vault/overSeer/self-improvement.md:92 注释**：扫描器已经找到 overSeer 自己代码里的 TODO/FIXME/HACK。挑一个让 codegen 实现。
  - vault/overSeer/designs/design-overseer-有-11-处-todo6-个文件.md:10 （6 个文件）
  - vault/overSeer/designs/design-overseer-有-11-处-todo6-个文件.md:17 /FIXME/HACK。挑一个让 codegen 实现。

共 28 处。建议归类处理或迁入 issue tracker。

## 建议动作
用 grep 全量列出 TODO，按文件聚类

## 风险
- 扫描器自动生成，可能误判

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
