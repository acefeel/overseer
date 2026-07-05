---
type: design
date: '2026-07-05'
project: aaws
tags:
  - design
  - aaws
  - hygiene
status: active
title: Design - aaws 工作树有 349 个未提交改动
createdAt: '2026-07-05T00:53:48.201Z'
updatedAt: '2026-07-05T00:53:48.201Z'
---
## 背景
modified=4 untracked=345 staged=0。建议尽快提交、stash 或拆分提交，避免与其他工作混杂。

## 建议动作
查看 `git status` + `git diff`，决定提交或拆分

## 风险
- (无)

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
