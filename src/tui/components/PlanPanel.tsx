import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';

interface PlanPanelProps {
  ipc: { request: (op: string, payload?: unknown, timeoutMs?: number) => Promise<unknown> };
  onClose: () => void;
  onNotify: (msg: string) => void;
}

export function PlanPanel({ ipc, onClose, onNotify }: PlanPanelProps) {
  const [project, setProject] = useState('');
  const [hint, setHint] = useState('');
  const [field, setField] = useState<0 | 1>(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
    } else if (key.tab) {
      setField((f) => (f === 0 ? 1 : 0));
    }
  });

  const submit = async () => {
    if (!project.trim()) return;
    setBusy(true);
    onNotify(`planning ${project}…`);
    try {
      const res = (await ipc.request(
        'supervise.plan',
        { project: project.trim(), hint: hint.trim() || undefined },
        300_000
      )) as any;
      setResult(res);
      onNotify(`plan ${res.status}${res.planNoteRel ? ` · ${res.planNoteRel}` : ''}`);
    } catch (e) {
      onNotify(`plan failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    return (
      <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
        <Text bold color="cyan">Plan Result</Text>
        <Text dimColor>Esc 返回</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text><Text bold>Status: </Text>{result.status}</Text>
          {result.error && <Text color="red">{result.error}</Text>}
          {result.planNoteRel && <Text>📝 {result.planNoteRel}</Text>}
          {Array.isArray(result.intentions) && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Intentions:</Text>
              {result.intentions.map((i: any) => (
                <Text key={i.id}>  [{i.severity}] {i.title} · id={i.id}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round" borderColor="cyan" height={22}>
      <Text bold color="cyan">Supervise Plan</Text>
      <Text dimColor>Tab 切换 · Enter 提交 · Esc 返回</Text>
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text color={field === 0 ? 'cyan' : 'gray'} bold>Project: </Text>
          <TextInput
            value={project}
            onChange={setProject}
            onSubmit={submit}
            placeholder="项目 id 或相对路径"
            focus={field === 0 && !busy}
            width={50}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={field === 1 ? 'cyan' : 'gray'} bold>Hint:  </Text>
          <TextInput
            value={hint}
            onChange={setHint}
            onSubmit={submit}
            placeholder="可选提示"
            focus={field === 1 && !busy}
            width={50}
          />
        </Box>
        {busy && (
          <Box marginTop={1}>
            <Text color="yellow">生成中…</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
