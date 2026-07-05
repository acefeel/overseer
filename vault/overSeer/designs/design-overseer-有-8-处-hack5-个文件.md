---
type: design
date: '2026-07-05'
project: overSeer
tags:
  - design
  - overSeer
  - tech-debt
status: active
title: Design - overSeer 有 8 处 HACK（5 个文件）
createdAt: '2026-07-05T02:24:51.621Z'
---
## 背景
代码中存在多处标记为 HACK 的技术债务，这表明当前模块的实现方式不够优雅和可维护。系统性地清理这些 'HACK' 不仅能提升代码的可读性和健壮性，还能确保未来功能的迭代能够基于更稳定的基础架构进行。这是一个典型的重构任务，需要结构化的分析和逐步解决。

## 建议动作
1. **调研阶段 (Investigation):** 使用 `grep` 或 IDE 的全局搜索功能，结合提供的文件列表（src/scanners/todo.ts, overSeer/overSeer/designs/...md），全量列出所有 HACK 标记的上下文代码。2. **分类与规划 (Planning):** 将这 8 个 HACK 根据其类型（是逻辑缺陷、架构限制还是临时补丁）进行归类，并决定每处 HACK 的最佳处理方案：A) 重构为标准模式；B) 如果无法重构，则增加详细的注释和文档说明原因。3. **执行阶段 (Implementation):** 按照文件和模块的依赖关系，分批次、小步快跑地进行代码修改。重点关注 src/scanners/todo.ts 的逻辑层面的优化，并确保所有设计文档（*.md）同步更新 HACK 的处理历史和新的最佳实践。

*建议提交一个包含所有修复点的 Pull Request，并在 PR 描述中详细说明每个 HACK 是如何被解决的。*

## 风险
- 可能误判：部分标记为 'HACK' 的代码可能是为了应对外部系统限制而设计的必要临时方案（Workaround），贸然移除可能会导致功能回归。
- 文档同步风险：由于涉及多个设计文档文件，在进行代码重构时，必须确保所有相关的设计决策和实现细节都能及时更新到对应的 Markdown 文件中，否则会造成知识库与实际代码的不一致。

## 状态
M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 `.overseer.json` 并设 `allowWrite=true`，然后用 CLI 触发 develop 阶段。
