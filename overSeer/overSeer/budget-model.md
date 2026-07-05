---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "Token 预算模型：四档等级 + 任务闸门"
tags: [budget, token, policy, rest]
---

# Token 预算模型：四档等级 + 任务闸门

## 等级（BudgetLevel）

| level | 触发条件（剩余 = min(日,周)） | recommendation |
|---|---|---|
| `ok` | > pad × 12 | `continue` |
| `caution` | pad × 4 ~ pad × 12 | `small_tasks_only` |
| `low` | pad ~ pad × 4 | `pause` |
| `exhausted` | ≤ pad | `stop` |

## 任务闸门 canRunTask(estimated)

拒掉的情况：
- recommendation == `stop`
- estimate > `perTaskEstimateCap`（默认 800k）→ 需拆分或人工 approve
- estimate + pad > 剩余
- recommendation == `pause` 且 estimate > pad → 暂停大任务

## "休息"行为

- daemon scheduler 在 `recommendation == stop` 时跳过巡检 tick。
- chat 入口在 stop 时直接拒绝、返回预算耗尽提示。
- onLowBudget 配置：log / pause / notify_cli。

## 数据来源

- **配置上限**（`config/overseer.config.yaml` `budget.*`）与 **provider 配额 API**（如可调）取交集。
- 实际累计走本地 `data/token-ledger.jsonl`，按 24h / 7d 滚动窗口聚合。

## 相关

- [[overSeer/decisions/stack-typescript-esm]]
