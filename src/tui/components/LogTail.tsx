import { Box, Text } from 'ink';

export interface LogTailProps {
  lines: string[];
  totalSize?: number;
  error?: string;
  /** 最多展示多少行（默认 10） */
  height?: number;
}

interface ParsedLine {
  parseOk: boolean;
  raw: string;
  time?: string;
  level?: number;
  levelLabel?: string;
  name?: string;
  msg?: string;
  ctx: Array<[string, string]>;
}

const LEVEL_LABEL: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function levelColor(level?: number): string {
  if (level === undefined) return 'gray';
  if (level >= 50) return 'red';
  if (level >= 40) return 'yellow';
  if (level >= 30) return 'cyan';
  return 'gray';
}

function parseLine(raw: string): ParsedLine {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const level = typeof o.level === 'number' ? o.level : undefined;
    const known = new Set(['time', 'level', 'msg', 'name', 'pid', 'hostname']);
    const ctx: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(o)) {
      if (known.has(k)) continue;
      ctx.push([k, formatVal(v)]);
      if (ctx.length >= 3) break;
    }
    return {
      parseOk: true,
      raw,
      time: typeof o.time === 'string' ? o.time : undefined,
      level,
      levelLabel: level !== undefined ? LEVEL_LABEL[level] ?? String(level) : undefined,
      name: typeof o.name === 'string' ? o.name : undefined,
      msg: typeof o.msg === 'string' ? o.msg : o.msg === undefined ? '' : JSON.stringify(o.msg),
      ctx,
    };
  } catch {
    return { parseOk: false, raw, ctx: [] };
  }
}

function formatVal(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > 28 ? v.slice(0, 28) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 32 ? s.slice(0, 32) + '…' : s;
  } catch {
    return '?';
  }
}

function shortTime(iso?: string): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'MB';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'KB';
  return n + 'B';
}

export function LogTail({ lines, totalSize, error, height = 10 }: LogTailProps) {
  const parsed = lines.map(parseLine);
  const shown = parsed.slice(-height);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan" bold>Live Log</Text>
        <Text dimColor>  ·  最近 {shown.length} 行</Text>
        {totalSize !== undefined && totalSize > 0 && (
          <Text dimColor>  ·  {fmtSize(totalSize)}</Text>
        )}
        <Text dimColor>  ·  daemon 实时活动（scan / 入队 / provider 调用 / snapshot / mode 切换 / 错误）</Text>
      </Box>
      {error ? (
        <Text color="red">  ⚠ {error}</Text>
      ) : shown.length === 0 ? (
        <Text dimColor>  (暂无日志，daemon 启动并活动后会出现)</Text>
      ) : (
        shown.map((l, idx) => {
          if (!l.parseOk) {
            return (
              <Box key={idx}>
                <Text dimColor>  {l.raw.slice(0, 120)}</Text>
              </Box>
            );
          }
          const lvl = (l.levelLabel ?? '?').padEnd(5);
          return (
            <Box key={idx}>
              <Text dimColor>{shortTime(l.time)} </Text>
              <Text color={levelColor(l.level) as any} bold>{lvl}</Text>
              {l.name && <Text color="blue">{l.name.padEnd(10).slice(0, 10)} </Text>}
              <Text>{(l.msg ?? '').slice(0, 70)}</Text>
              {l.ctx.length > 0 && (
                <Text dimColor> {l.ctx.map(([k, v]) => `${k}=${v}`).join(' ')}</Text>
              )}
            </Box>
          );
        })
      )}
    </Box>
  );
}
