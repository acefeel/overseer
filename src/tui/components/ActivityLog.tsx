import { Box, Text } from 'ink';

export interface ActivityEntry {
  kind: 'cycle' | 'memory' | 'mode' | 'action';
  ts: string;
  text: string;
  detail?: string;
}

function shortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function kindColor(k: ActivityEntry['kind']): string {
  switch (k) {
    case 'cycle':
      return 'cyan';
    case 'memory':
      return 'green';
    case 'mode':
      return 'magenta';
    case 'action':
      return 'yellow';
  }
}

function kindTag(k: ActivityEntry['kind']): string {
  return k.padEnd(7);
}

export function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>Activity</Text>
        <Text dimColor>  ·  最近 {entries.length} 条</Text>
      </Box>
      {entries.length === 0 ? (
        <Text dimColor>  (暂无活动)</Text>
      ) : (
        entries.slice(0, 8).map((e, idx) => (
          <Box key={idx}>
            <Text dimColor>{shortTime(e.ts)} </Text>
            <Text color={kindColor(e.kind) as any} bold>{kindTag(e.kind)}</Text>
            <Text> {e.text}</Text>
          </Box>
        ))
      )}
    </Box>
  );
}
