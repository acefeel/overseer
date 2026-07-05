import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PendingApproval } from '../../supervisor/approvals.js';

interface ApprovalsPanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function ApprovalsPanel({ ipc, onClose, onNotify }: ApprovalsPanelProps) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [selected, setSelected] = useState(0);

  const refresh = async () => {
    try {
      const list = (await ipc.request('approvals.list', { pendingOnly: true })) as PendingApproval[];
      setItems(list);
      setSelected((s) => Math.min(s, Math.max(0, list.length - 1)));
    } catch (e) {
      onNotify(`approvals refresh failed: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelected((s) => (s <= 0 ? items.length - 1 : s - 1));
    } else if (key.downArrow) {
      setSelected((s) => (s >= items.length - 1 ? 0 : s + 1));
    } else if (input === 'r') {
      refresh();
    } else if (input === 'a') {
      decide('approved');
    } else if (input === 'd') {
      decide('rejected');
    }
  });

  const decide = async (status: 'approved' | 'rejected') => {
    const id = items[selected]?.id;
    if (!id) return;
    try {
      await ipc.request('approvals.decide', { id, status });
      onNotify(`${id} → ${status}`);
      await refresh();
    } catch (e) {
      onNotify(`decision failed: ${(e as Error).message}`);
    }
  };

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Box>
        <Text bold color="cyan">Approvals</Text>
        <Text dimColor>  ↑↓ 选择 · a 批准 · d 拒绝 · r 刷新 · Esc 返回</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 ? (
          <Text dimColor>没有待批准项</Text>
        ) : (
          items.map((item, idx) => {
            const active = idx === selected;
            return (
              <Box key={item.id} flexDirection="column" marginBottom={1}>
                <Text color={active ? 'cyan' : 'white'} bold={active}>
                  {active ? '> ' : '  '}
                  {item.id} [{item.action}]
                </Text>
                <Text>  {item.description}</Text>
                <Text dimColor>  project={item.project} · {item.ts}</Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
