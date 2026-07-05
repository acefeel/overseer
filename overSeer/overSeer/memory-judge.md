---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "Memory Judge：信息价值判断器"
tags: [memory, judge, kb, automation]
---

# Memory Judge：信息价值判断器

## 设计原则

不是每轮 chat 都写 vault（会噪音爆炸）。**只在"这条信息丢了会不会误导后续决策"为真时**才落笔记。

## 触发流程

1. supervisor.chat() 拿到 assistant 回复
2. 若 message 过短（userText < 8 且 assistantText < 60）→ 跳过 judge，节省 token
3. 否则调一个 LLM summary 任务（temperature 0.1，maxTokens 800）
4. judge 返回严格 JSON：`{ shouldWrite, reason, note? }`
5. `shouldWrite=true` → writer.write 落笔记 + appendDaily 加索引

## 判定标准（命中任一即应写）

- 架构/选型/技术决策（ADR）：选 X 不选 Y、为什么
- 项目结构/约束/边界：哪个模块在哪个目录、不能改什么
- 协议/接口/数据契约：字段、格式、约束
- 业务规则/优先级/模式：先 A 后 B、什么触发什么
- 教训/陷阱：踩过的坑、副作用
- 用户偏好/工作方式

## 不该写

- 闲聊、问候、一次性命令查询
- 已存在 vault 的内容（除非有重要修正）
- 模糊、未拍板的讨论

## 输出笔记类型映射

`adr | knowledge | plan | design | retro | budget`（不写 daily/chat_log/moc，这些走专门入口）

## 失败兜底

- judge 调用失败 / 返回非 JSON → 不写、记 warn 日志，不影响主 chat 流程。

## 相关

- [[overSeer/knowledge/budget-model]]
