---
type: design
date: '2026-07-05'
project: aaws
tags:
  - design
  - aaws
  - tech-debt
status: active
title: Design - aaws 有 2 处 NOTE（2 个文件）
createdAt: '2026-07-05T00:51:43.055Z'
updatedAt: '2026-07-05T00:51:43.055Z'
---
## 背景
示例：
  - keepalived-notify.sh:82 real-PLC workers (S1/L001/L002) are NO LONGER started/stopped here.
  - web/assets/index-DOk2x30E.js:404 This will not work correctly for non-generic events such as `change`,

共 2 处。建议归类处理或迁入 issue tracker。

## 建议动作
用 grep 全量列出 NOTE，按文件聚类

## 风险
- (无)

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
