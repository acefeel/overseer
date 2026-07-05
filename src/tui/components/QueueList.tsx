import { Box, Text } from 'ink';

export interface QueueItem {
  id: string;
  project: string;
  source: string;
  category: string;
  severity: string;
  title: string;
  status: string;
  lastSeen: string;
}

function sevColor(sev: string): string {
  if (sev === 'critical') return 'red';
  if (sev === 'high') return 'magenta';
  if (sev === 'medium') return 'yellow';
  return 'gray';
}

function sevTag(sev: string): string {
  return sev.toUpperCase().padEnd(8);
}

function shortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function QueueList({ items }: { items: QueueItem[] }) {
  const pending = items.filter((i) => i.status === 'pending').slice(0, 8);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>Queue</Text>
        <Text dimColor>  ·  {pending.length} pending</Text>
      </Box>
      {pending.length === 0 ? (
        <Text dimColor>  (空。按 r 跑一轮 cycle)</Text>
      ) : (
        pending.map((i) => (
          <Box key={i.id}>
            <Text color={sevColor(i.severity) as any} bold>{sevTag(i.severity)}</Text>
            <Text> </Text>
            <Text dimColor>[{i.source}/{i.category}]</Text>
            <Text> </Text>
            <Text>{i.title.slice(0, 48)}</Text>
            <Text dimColor> {shortTime(i.lastSeen)}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
