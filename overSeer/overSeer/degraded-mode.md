---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "Degraded Mode：主力预算耗尽时切本地 fallback"
tags: [mode, degraded, fallback, local, ollama, safety]
---

# Degraded Mode：主力预算耗尽时切本地 fallback

## 设计目标

主力 GLM-5.2 逼近 token 门限时，不直接拒绝服务，而是切到本地小模型（Ollama/LM Studio）作为"无限 token 来源"，**仅承担**：

1. **事务调度 / 事件响应**：daemon scheduler tick、内部消息路由
2. **对外界输入做简要回复**：用户 chat 仍可用

**绝对禁止**（即使被路由到也不能做）：

- ❌ 修改任何文件
- ❌ 删除任何文件
- ❌ 执行 shell 命令
- ❌ git commit / push / reset
- ❌ 写记忆（memory judge 关闭，避免误判垃圾信息为决策点）

## 模式判定（ModePolicy）

`mode = f(预算等级, 主链是否可用, fallback 是否可用)`

| 主链 ready | budget.level | hasFallback | mode | trigger |
|---|---|---|---|---|
| ✓ | ok / caution | * | **normal** | normal |
| ✓ | low / exhausted | true | **degraded** | budget |
| ✓ | low / exhausted | false | **stopped** | no-fallback |
| **✗（无 key/未启用/全失败）** | ok / caution | true | **degraded** | **no-main** |
| **✗** | low / exhausted | true | **degraded** | no-main |
| **✗** | * | false | **stopped** | no-fallback |

**关键**：主控 provider 不可用（未配置 apiKey、被 disabled、或主链全失败）也视为该切 fallback —— **不必等到预算耗尽**。这让"只装好 Ollama、还没填主控 key"的开发期也能直接用 chat/调度。

每次 chat 和每次 scheduler tick 都会 `recomputeMode()`，模式变化时自动写一条 `budget` 类型笔记到 vault，含 `trigger` 字段（budget / no-main / no-fallback）便于审计。

## ActionPolicy（canPerform）

| Action | normal | degraded | stopped |
|---|---|---|---|
| read / retrieve / status | ✅ | ✅ | ❌ |
| chat | ✅ | ✅ | ❌ |
| plan / design / evaluate | ✅ | ❌ | ❌ |
| memory.write (judge) | ✅ | ❌ | ❌ |
| file.write / file.delete | ✅ | ❌ | ❌ |
| git.commit / git.push | ✅ | ❌ | ❌ |
| shell.exec | ✅ | ❌ | ❌ |

## Provider 角色与 canAct

- `role: main`（如 glm）→ `canAct: true`，可承担所有动作
- `role: fallback`（如 local）→ **`canAct: false` 永远**，路由器即便在 normal 模式也不会用它做写入

这层"双保险"确保即使有 bug 让 fallback 被误调，provider 自己也拒绝 side-effect 调用。

## chat 行为差异

| 维度 | normal | degraded |
|---|---|---|
| system prompt | 全能力监理 | 明确说明"只调度/回复，不能动" |
| 检索 vault | ✅ | ✅（只读允许） |
| 调用 LLM | 主链 (router.chat) | router.chatViaFallback |
| 回复前缀 | 无 | `⚠ [降级模式] ...` 横幅 |
| judge 触发 | 可能 | **不触发** |
| 写 vault | 可能 | **不写**（除模式切换自身的 budget 笔记） |

## 自动恢复

- 预算重置（跨日 / 跨周）→ `dailyUsage` / `weeklyUsage` 归零
- 下次 chat 或 tick 时 `recomputeMode()` 发现 level 回到 ok/caution → 切回 normal
- 切换都会留 vault 笔记审计

## 配置（节选）

```yaml
providers:
  local:
    enabled: false              # 装好 Ollama 后改 true
    kind: local
    role: fallback              # 关键
    baseUrl: http://localhost:11434/v1
    apiKey: "ollama"
    model: qwen2.5-coder:7b
router:
  chain: [glm]
  fallback: local               # 主链耗尽时切到这里
```

## 启用步骤

1. 装 Ollama：`winget install Ollama.Ollama`（Windows）
2. 拉模型：`ollama pull qwen2.5-coder:7b`
3. 改配置 `providers.local.enabled: true`
4. `overseer status` 应显示 `local fallback [fallback] (read-only)`
5. 模拟耗尽预算（把 `budget.dailyLimitTokens` 改成比当日已用稍大的值），下次 chat 自动降级

## 相关

- [[overSeer/knowledge/budget-model]]
- [[overSeer/knowledge/ipc-design]]
- [[overSeer/decisions/stack-typescript-esm]]
