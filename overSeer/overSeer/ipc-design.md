---
type: knowledge
date: 2026-07-04
project: overSeer
status: active
title: "IPC 设计：CLI ↔ daemon 通信管道"
tags: [ipc, daemon, windows, named-pipe]
---

# IPC 设计：CLI ↔ daemon 通信管道

## 协议

- 传输：newline-delimited JSON over TCP socket。
- 地址：
  - Windows: `\\.\pipe\overseer`
  - Unix: `/tmp/overseer.sock`
- `IpcRequest = { id, op, payload }`，`IpcResponse = { id, ok, data?, error? }`。

## 当前 ops

- `ping` → `{ pong, ts }`
- `status` → providers / budget / historyLen / vaultNotes
- `chat` `{ text, opts }` → `{ reply, model, provider, retrievedNotes, memoryWritten }`
- `kb.search` / `kb.recent`
- `reset`

## 关键约定

- daemon 不在线时 CLI 自动**降级**为本地内联 `Supervisor`，保证单次调试可用。
- IPC 服务端逐行解析，每连接独立，无会话状态（除 supervisor 内部 history）。
- 写入 socket 前用 try/catch 兜底，socket 已断不算致命错误。

## 相关

- [[overSeer/decisions/stack-typescript-esm]]
- [[overSeer/knowledge/daemon-lifecycle]]
