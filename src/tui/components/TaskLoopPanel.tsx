import { Box, Text } from 'ink';

export interface TaskLoopData {
  state: string;
  currentTaskId?: string;
  currentTaskTitle?: string;
  currentProject?: string;
  pendingCount: number;
  milestones: Array<{ projectId: string; reached: boolean; reason: string; ts: string; consultantVerified: boolean }>;
  lastCycleAt?: string;
  lastConsultantCheckAt?: string;
  lastError?: string;
  iterationsCompleted: number;
}

function stateColor(s: string): string {
  switch (s) {
    case 'running':
      return 'green';
    case 'scanning':
      return 'cyan';
    case 'consulting':
      return 'magenta';
    case 'resting':
      return 'yellow';
    case 'paused':
      return 'gray';
    case 'error':
      return 'red';
    default:
      return 'gray';
  }
}

function stateIcon(s: string): string {
  switch (s) {
    case 'running':
      return '⚙';
    case 'scanning':
      return '🔍';
    case 'consulting':
      return '🧠';
    case 'resting':
      return '😴';
    case 'paused':
      return '⏸';
    case 'error':
      return '✗';
    default:
      return '○';
  }
}

function shortTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function TaskLoopPanel({ data }: { data: TaskLoopData | null | undefined }) {
  if (!data) {
    return (
      <Box>
        <Text dimColor>taskloop: (no data)</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>TaskLoop</Text>
        <Text dimColor>  ·  </Text>
        <Text color={stateColor(data.state) as any} bold>
          {stateIcon(data.state)} {data.state}
        </Text>
        <Text dimColor>  ·  pending: </Text>
        <Text color={data.pendingCount > 0 ? 'yellow' : 'gray'} bold>{data.pendingCount}</Text>
        <Text dimColor>  ·  done: </Text>
        <Text color="green">{data.iterationsCompleted}</Text>
      </Box>

      {data.currentTaskTitle && (
        <Box>
          <Text dimColor>current: </Text>
          <Text color="yellow">[{data.currentProject}] </Text>
          <Text>{data.currentTaskTitle.slice(0, 60)}</Text>
        </Box>
      )}

      {data.milestones.length > 0 && (
        <Box flexDirection="column">
          {data.milestones.map((m) => (
            <Box key={m.projectId}>
              <Text dimColor>milestone: </Text>
              <Text color={m.reached ? 'green' : 'yellow'} bold={m.reached}>
                {m.reached ? '✓' : '○'} {m.projectId}
              </Text>
              {m.consultantVerified && <Text color="magenta" dimColor> ✓consultant</Text>}
              <Text dimColor> {m.reason.slice(0, 50)}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box>
        {data.lastConsultantCheckAt && (
          <>
            <Text dimColor>last consult: {shortTime(data.lastConsultantCheckAt)}  </Text>
          </>
        )}
        {data.lastCycleAt && <Text dimColor>last cycle: {shortTime(data.lastCycleAt)}</Text>}
      </Box>

      {data.state === 'resting' && (
        <Box>
          <Text color="yellow">😴 所有项目已 milestone，等待用户指令（chat 或 IPC 触发 resume）</Text>
        </Box>
      )}

      {data.state === 'error' && data.lastError && (
        <Box>
          <Text color="red">⚠ {data.lastError}</Text>
        </Box>
      )}
    </Box>
  );
}
