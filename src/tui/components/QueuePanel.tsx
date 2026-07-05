import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { QueueItem } from '../../supervisor/queue.js';

interface QueuePanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  onNotify: (msg: string) => void;
}

function sevColor(sev: string): any {
  if (sev === 'critical') return 'red';
  if (sev === 'high') return 'magenta';
  if (sev === 'medium') return 'yellow';
  return 'gray';
}

export function QueuePanel({ ipc, onClose, onNotify }: QueuePanelProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<QueueItem | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const list = (await ipc.request('queue.list', { limit: 50 })) as QueueItem[];
      setItems(list);
      setSelected((s) => Math.min(s, Math.max(0, list.length - 1)));
    } catch (e) {
      onNotify(`queue refresh failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      if (detail) setDetail(null);
      else onClose();
      return;
    }
    if (detail) {
      if (key.return || input === 'e') {
        const item = detail;
        setDetail(null);
        runExecute(item.id);
      }
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s <= 0 ? items.length - 1 : s - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s >= items.length - 1 ? 0 : s + 1));
    } else if (key.return) {
      setDetail(items[selected] ?? null);
    } else if (input === 'r') {
      refresh();
    } else if (input === 'd') {
      const id = items[selected]?.id;
      if (id) dropItem(id);
    } else if (input === 'e') {
      const id = items[selected]?.id;
      if (id) runExecute(id);
    }
  });

  const dropItem = async (id: string) => {
    try {
      await ipc.request('queue.drop', { id });
      onNotify(`dropped ${id}`);
      await refresh();
    } catch (e) {
      onNotify(`drop failed: ${(e as Error).message}`);
    }
  };

  const runExecute = async (id: string) => {
    setBusy(true);
    onNotify(`executing ${id}…`);
    try {
      const res = (await ipc.request('queue.execute', { id }, 300_000)) as any;
      onNotify(`${id} → ${res.status}${res.designNoteRel ? ` · ${res.designNoteRel}` : ''}`);
      await refresh();
    } catch (e) {
      onNotify(`execute failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (detail) {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
        <Text bold color="cyan">Queue Item</Text>
        <Text dimColor>Esc 返回 · Enter/e 执行 · d 删除</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>ID: </Text>{detail.id}</Text>
          <Text><Text bold>Project: </Text>{detail.project}</Text>
          <Text><Text bold>Status: </Text>{detail.status}</Text>
          <Text><Text bold>Severity: </Text><Text color={sevColor(detail.severity)}>{detail.severity}</Text></Text>
          <Text><Text bold>Title: </Text>{detail.title}</Text>
          <Text><Text bold>Detail:</Text></Text>
          <Text>{detail.detail}</Text>
          {detail.hint && <Text><Text bold>Hint: </Text>{detail.hint}</Text>}
          {detail.files && detail.files.length > 0 && (
            <Text><Text bold>Files: </Text>{detail.files.join(', ')}</Text>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Box>
        <Text bold color="cyan">Queue</Text>
        <Text dimColor>  ↑↓ 选择 · Enter 详情 · e 执行 · d 删除 · r 刷新 · Esc 返回</Text>
      </Box>
      {busy && <Text color="yellow">处理中…</Text>}
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>队列为空</Text>
        ) : (
          items.map((item, idx) => {
            const active = idx === selected;
            return (
              <Box key={item.id}>
                <Text color={active ? 'cyan' : 'gray'} bold={active}>
                  {active ? '> ' : '  '}
                </Text>
                <Text color={sevColor(item.severity)} bold={active}>
                  {item.severity.toUpperCase().padEnd(8)}
                </Text>
                <Text> [{item.source}/{item.category}] {item.title.slice(0, 42)}</Text>
                <Text dimColor>  {item.status}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
