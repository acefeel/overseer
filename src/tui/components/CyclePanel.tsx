import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';

interface CyclePanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function CyclePanel({ ipc, onClose, onNotify }: CyclePanelProps) {
  const [aggressiveness, setAggressiveness] = useState<'light' | 'normal' | 'full'>('normal');
  const [project, setProject] = useState('');
  const [autoExecute, setAutoExecute] = useState(false);
  const [allowShell, setAllowShell] = useState(false);
  const [field, setField] = useState<0 | 1 | 2 | 3>(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.tab) {
      setField((f) => ((f + 1) % 4) as 0 | 1 | 2 | 3);
      return;
    }
    if (field === 0) {
      if (input === 'l') setAggressiveness('light');
      if (input === 'n') setAggressiveness('normal');
      if (input === 'f') setAggressiveness('full');
    }
    if (field === 2 && (input === ' ' || input === 'y')) setAutoExecute((v) => !v);
    if (field === 3 && (input === ' ' || input === 'y')) setAllowShell((v) => !v);
  });

  const submit = async () => {
    setBusy(true);
    onNotify('running cycle…');
    try {
      const res = (await ipc.request(
        'cycle.run',
        {
          aggressiveness,
          autoExecute,
          allowShellDuringScan: allowShell,
          onlyProjects: project.trim() ? [project.trim()] : [],
        },
        600_000
      )) as any;
      setResult(res);
      onNotify(`cycle done · mode=${res.mode} · queue=${res.queueAfter} (+${res.added})`);
    } catch (e) {
      onNotify(`cycle failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
        <Text bold color="cyan">Cycle Result</Text>
        <Text dimColor>Esc 返回</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>Mode: </Text>{result.mode}</Text>
          <Text><Text bold>Projects: </Text>{result.projects?.length ?? 0}</Text>
          <Text><Text bold>Queue: </Text>{result.queueBefore} → {result.queueAfter}</Text>
          <Text><Text bold>Added: </Text>{result.added} · Updated: {result.updated} · Pruned: {result.pruned}</Text>
          {result.executed && (
            <Text><Text bold>Executed: </Text>{result.executed.queueId} → {result.executed.status}</Text>
          )}
          {result.projects?.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Per project:</Text>
              {result.projects.map((p: any) => (
                <Text key={p.id}>  {p.id}: {p.durationMs}ms · {JSON.stringify(p.perScanner)}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Text bold color="cyan">Run Cycle</Text>
      <Text dimColor>Tab 切换 · Enter 提交 · Esc 返回</Text>
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={field === 0 ? 'cyan' : 'gray'} bold>Aggressiveness: </Text>
          {(['light', 'normal', 'full'] as const).map((a) => (
            <Text key={a} color={aggressiveness === a ? 'cyan' : 'gray'} bold={aggressiveness === a}>
              [{a[0]}]{a}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={field === 1 ? 'cyan' : 'gray'} bold>Project: </Text>
          <TextInput
            value={project}
            onChange={setProject}
            onSubmit={submit}
            placeholder="留空 = 全部项目"
            focus={field === 1 && !busy}
            width={50}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={field === 2 ? 'cyan' : 'gray'} bold>Auto execute: </Text>
          <Text color={autoExecute ? 'green' : 'gray'}>{autoExecute ? 'YES' : 'NO'}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={field === 3 ? 'cyan' : 'gray'} bold>Allow shell: </Text>
          <Text color={allowShell ? 'green' : 'gray'}>{allowShell ? 'YES' : 'NO'}</Text>
        </Box>
        {busy && (
          <Box marginTop={1}>
            <Text color="yellow">运行中…</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
