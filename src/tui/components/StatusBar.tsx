import { Box, Text } from 'ink';

interface ProviderInfo {
  id: string;
  kind: string;
  role: string;
  ready: boolean;
  model: string;
  canAct: boolean;
}

interface BudgetSnapshot {
  level: string;
  daily: { used: number; limit: number; remaining: number; pct: number };
  weekly: { used: number; limit: number; remaining: number; pct: number };
  safetyPad: number;
  recommendation: string;
}

interface StatusData {
  mode: string;
  fallback: string | null;
  providers: ProviderInfo[];
  activeChain: string[];
  budget: BudgetSnapshot;
  historyLen: number;
  vaultNotes: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function bar(used: number, limit: number, width = 24): string {
  const pct = limit ? Math.min(1, used / limit) : 0;
  const filled = Math.round(width * pct);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function levelColor(level: string): string {
  if (level === 'ok') return 'green';
  if (level === 'caution') return 'yellow';
  if (level === 'low') return 'magenta';
  return 'red';
}

function modeColor(mode: string): string {
  if (mode === 'normal') return 'green';
  if (mode === 'degraded') return 'magenta';
  return 'red';
}

export function StatusBar({ status }: { status: StatusData | null }) {
  if (!status) {
    return (
      <Box flexDirection="column">
        <Text color="gray">正在加载状态…</Text>
      </Box>
    );
  }
  const b = status.budget;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>overSeer</Text>
        <Text dimColor>  ·  mode: </Text>
        <Text color={modeColor(status.mode)} bold>{status.mode}</Text>
        <Text dimColor>  ·  fallback: </Text>
        <Text color={status.fallback ? 'magenta' : 'gray'}>
          {status.fallback ?? '(none)'}
        </Text>
        <Text dimColor>  ·  vault: </Text>
        <Text color="cyan">{status.vaultNotes} notes</Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>today </Text>
        <Text color={levelColor(b.level)}>{bar(b.daily.used, b.daily.limit)}</Text>
        <Text> {fmt(b.daily.used)} / {fmt(b.daily.limit)} </Text>
        <Text dimColor>tokens</Text>
      </Box>
      <Box>
        <Text dimColor>week  </Text>
        <Text color={levelColor(b.level)}>{bar(b.weekly.used, b.weekly.limit)}</Text>
        <Text> {fmt(b.weekly.used)} / {fmt(b.weekly.limit)} </Text>
        <Text dimColor>tokens</Text>
      </Box>
      <Box>
        <Text dimColor>level:</Text>
        <Text color={levelColor(b.level)} bold> {b.level} </Text>
        <Text dimColor>→ {b.recommendation}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>providers:</Text>
        {status.providers.map((p) => {
          const tag = !p.ready ? '○ off    ' : p.role === 'fallback' ? '◆ fallback' : '✓ ready  ';
          const tagColor = !p.ready ? 'gray' : p.role === 'fallback' ? 'magenta' : 'green';
          const inChain = status.activeChain.includes(p.id);
          const tail = inChain ? ' [main]' : p.role === 'fallback' ? ' [fallback]' : '';
          const ro = p.canAct ? '' : ' (read-only)';
          return (
            <Box key={p.id}>
              <Text color={tagColor as any}>{tag}</Text>
              <Text> </Text>
              <Text bold>{p.id.padEnd(10)}</Text>
              <Text dimColor> {p.kind.padEnd(10)} </Text>
              <Text>{p.model.padEnd(22)}</Text>
              <Text color="cyan">{tail}</Text>
              <Text dimColor>{ro}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
