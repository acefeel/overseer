---
type: moc
created: 2026-07-04
tags: [index, moc]
---

# overSeer 知识库索引

> 这是 overSeer 自主维护的 Obsidian vault。overSeer 会在每轮 chat 后用一个"信息价值判断器"决定是否落笔记：**判断标准是"这条信息丢了会不会误导后续决策"**，命中即写。

## 一、overSeer 自身

- 每日笔记：[[overSeer/daily/|daily/]]
- 决策记录 (ADR)：[[overSeer/decisions/|decisions/]]
- 预算台账：[[overSeer/budgets/|budgets/]]

## 二、监理的项目

- [[aaws/|aaws]]
- [[JHAVSP/|JHAVSP]]

## 三、Dataview 仪表盘

> 需要在 Obsidian 中启用 Dataview 社区插件（配置已预置在 `.obsidian/community-plugins.json`）。

### 最近 10 条笔记

```dataview
TABLE type AS "类型", project AS "项目", date AS "日期", status AS "状态"
FROM "" WHERE type != null
SORT file.mtime DESC LIMIT 10
```

### 待执行的 plan

```dataview
TABLE project AS "项目", date AS "日期"
FROM "" WHERE type = "plan" AND status = "active"
SORT date DESC
```

### 已完成 ADR

```dataview
TABLE project AS "项目", date AS "日期"
FROM "" WHERE type = "adr"
SORT date DESC LIMIT 15
```

## 四、笔记类型约定

| type | 目录 | 含义 |
|---|---|---|
| `moc` | INDEX.md | Map of Content |
| `daily` | overSeer/daily | 每日健康/进度/决策摘要 |
| `adr` | overSeer/decisions | 架构/重要决策记录 |
| `budget` | overSeer/budgets | 预算快照与限流事件 |
| `plan` | `<project>/plans` | 项目改进计划（PDCAE 的 P） |
| `design` | `<project>/designs` | 设计文档（PDCAE 的 D） |
| `retro` | `<project>/retros` | 评估回顾（PDCAE 的 E） |
| `knowledge` | `<project>/` | 项目相关知识沉淀 |
| `chat_log` | overSeer/chat-logs | 关键对话留档 |

## 五、frontmatter 约定

```yaml
---
type: daily | adr | plan | design | retro | budget | knowledge | chat_log
date: YYYY-MM-DD
project: overSeer | aaws | JHAVSP | ...
tags: [...]
status: draft | active | done | abandoned | superseded
title: 简洁标题
---
```

## 六、CLI 操作

```bash
overseer kb search "预算"        # 全文 + frontmatter 检索
overseer kb recent --limit 20    # 最近笔记
overseer kb show overSeer/decisions/foo
overseer kb stats                # 按类型/项目统计
overseer kb write --type adr --title "..." --body "..."
```
