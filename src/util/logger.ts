import { PATHS } from './paths.js';
import path from 'node:path';
import fs from 'node:fs';
import pino, { transport as pinoTransport } from 'pino';
import { parse as parseYaml } from 'yaml';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LoggingCfg {
  level: Level;
  pretty: boolean;
  /** 日志文件绝对路径（JSON 行）；daemon 后台运行时的主要可观测来源 */
  file: string;
}

let cached: LoggingCfg | null = null;

function readLoggingConfig(): LoggingCfg {
  if (cached) return cached;
  const fallback: LoggingCfg = { level: 'info', pretty: true, file: PATHS.LOG_FILE };
  try {
    const raw = fs.readFileSync(PATHS.MAIN_CONFIG, 'utf8');
    const doc = parseYaml(raw) as { logging?: { level?: Level; pretty?: boolean; file?: string } };
    cached = {
      level: doc?.logging?.level ?? fallback.level,
      pretty: doc?.logging?.pretty ?? fallback.pretty,
      file: doc?.logging?.file ? path.resolve(PATHS.ROOT, doc.logging.file) : fallback.file,
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
  const { level, pretty, file } = readLoggingConfig();
  // 双 destination：
  //   - stdout：前台运行时看得到（pretty 彩色 或 纯 JSON）
  //   - 文件：JSON 行，daemon 后台运行（launcher 用 stdio:'ignore'）时的主要可观测来源，
  //           也供 TUI 的 logs.tail / Live Log 面板读取
  const targets: any[] = [];
  if (pretty) {
    targets.push({
      target: 'pino-pretty',
      level,
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        destination: 1,
      },
    });
  } else {
    targets.push({ target: 'pino/file', level, options: { destination: 1 } });
  }
  targets.push({ target: 'pino/file', level, options: { destination: file, mkdir: true } });
  const transport = pinoTransport({ targets });
  const base = pino(
    {
      level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport as any
  );
  _logger = wrap(base);
  return _logger.child({ name });
}
