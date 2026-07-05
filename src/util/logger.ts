import { PATHS } from './paths.js';
import fs from 'node:fs';
import pino, { transport as pinoTransport } from 'pino';
import { parse as parseYaml } from 'yaml';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

let cached: { level: Level; pretty: boolean } | null = null;

function readLoggingConfig(): { level: Level; pretty: boolean } {
  if (cached) return cached;
  const fallback: { level: Level; pretty: boolean } = { level: 'info', pretty: true };
  try {
    const raw = fs.readFileSync(PATHS.MAIN_CONFIG, 'utf8');
    const doc = parseYaml(raw) as { logging?: { level?: Level; pretty?: boolean } };
    cached = {
      level: doc?.logging?.level ?? fallback.level,
      pretty: doc?.logging?.pretty ?? fallback.pretty,
    };
    return cached;
  } catch {
    cached = fallback;
    return cached;
  }
}

export interface Logger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

let _logger: Logger | null = null;

function wrap(base: pino.Logger): Logger {
  const b = base as any;
  return {
    trace: (...a) => b.trace(...a),
    debug: (...a) => b.debug(...a),
    info: (...a) => b.info(...a),
    warn: (...a) => b.warn(...a),
    error: (...a) => b.error(...a),
    child: (bindings) => wrap(base.child(bindings)),
  };
}

export function getLogger(name = 'overseer'): Logger {
  if (_logger) return _logger.child({ name });
  const { level, pretty } = readLoggingConfig();
  const transport = pretty
    ? pinoTransport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname',
          destination: 1,
        },
      })
    : undefined;
  const base = pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  }, transport as any);
  _logger = wrap(base);
  return _logger.child({ name });
}
