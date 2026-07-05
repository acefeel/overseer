---
type: design
date: '2026-07-05'
project: aaws
tags:
  - design
  - aaws
  - tech-debt
status: active
title: Design - aaws 有 3 处 TODO（3 个文件）
createdAt: '2026-07-05T00:51:44.573Z'
updatedAt: '2026-07-05T00:51:44.573Z'
---
## 背景
示例：
  - web/assets/index-DOk2x30E.js:414 Fix the incorrect navigation interaction "),w(s)?Ae("v-if",!0):(O(),X("i",{key:3,class:Y(w(i).m("clo
  - tools/screw-plus/8.0/run-tests.php:1684 Cleanup when removed from Zend Engine.
  - rTransit-MCS/src/stand/actor.rs:323 parse and schedule.

共 3 处。建议归类处理或迁入 issue tracker。

## 建议动作
用 grep 全量列出 TODO，按文件聚类

## 风险
- (无)

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
