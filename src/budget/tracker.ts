import fs from 'node:fs';
import { PATHS } from '../util/paths.js';
import { getLogger } from '../util/logger.js';
import type { TokenUsage } from '../providers/base.js';

export interface ProviderMetric {
  ts: string;
  provider: string;
  model: string;
  task?: string;
  latencyMs: number;
  ok: boolean;
  statusCode?: number;
  error?: string;
  retryCount: number;
  attemptedModels: string[];
}

export interface LedgerEntry {
  ts: string;
  provider: string;
  model: string;
  task?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  ok: boolean;
  error?: string;
}

export class TokenTracker {
  private log = getLogger('tracker');
  private buffer: LedgerEntry[] = [];
  private metricBuffer: ProviderMetric[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushIntervalMs = 5000;
  private cache: LedgerEntry[] | null = null;

  record(
    provider: string,
    model: string,
    usage: TokenUsage,
    opts: { task?: string; ok?: boolean; error?: string } = {}
  ): void {
    const entry: LedgerEntry = {
      ts: new Date().toISOString(),
      provider,
      model,
      task: opts.task,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      ok: opts.ok ?? true,
      error: opts.error,
    };
    this.buffer.push(entry);
    this.cache = null;
    this.scheduleFlush();
  }

  recordMetric(metric: ProviderMetric): void {
    this.metricBuffer.push(metric);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((e) => this.log.error({ err: String(e) }, 'ledger flush failed'));
    }, this.flushIntervalMs);
  }

  async flush(): Promise<void> {
    if (this.buffer.length > 0) {
      const toWrite = this.buffer.splice(0);
      const lines = toWrite.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.promises.appendFile(PATHS.TOKEN_LEDGER, lines, 'utf8');
      this.cache = null;
    }
    if (this.metricBuffer.length > 0) {
      const toWrite = this.metricBuffer.splice(0);
      const lines = toWrite.map((m) => JSON.stringify(m)).join('\n') + '\n';
      await fs.promises.appendFile(PATHS.METRICS_LEDGER, lines, 'utf8');
    }
  }

  async flushSync(): Promise<void> {
    return this.flush();
  }

  readAll(): LedgerEntry[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(PATHS.TOKEN_LEDGER)) {
      this.cache = [];
      return this.cache;
    }
    const out: LedgerEntry[] = [];
    const text = fs.readFileSync(PATHS.TOKEN_LEDGER, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as LedgerEntry);
      } catch {
        /* skip corrupt line */
      }
    }
    this.cache = out;
    return out;
  }

  sumSince(sinceTs: number): {
    prompt: number;
    completion: number;
    total: number;
    byProvider: Record<string, number>;
  } {
    const all = this.readAll();
    let prompt = 0,
      completion = 0,
      total = 0;
    const byProvider: Record<string, number> = {};
    for (const e of all) {
      const t = Date.parse(e.ts);
      if (t < sinceTs) continue;
      prompt += e.promptTokens;
      completion += e.completionTokens;
      total += e.totalTokens;
      byProvider[e.provider] = (byProvider[e.provider] ?? 0) + e.totalTokens;
    }
    return { prompt, completion, total, byProvider };
  }

  startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  startOfWeek(): number {
    const d = new Date();
    const day = d.getDay() || 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (day - 1));
    return d.getTime();
  }

  dailyUsage(): { prompt: number; completion: number; total: number; byProvider: Record<string, number> } {
    return this.sumSince(this.startOfDay());
  }

  weeklyUsage(): { prompt: number; completion: number; total: number; byProvider: Record<string, number> } {
    return this.sumSince(this.startOfWeek());
  }
}

let _tracker: TokenTracker | null = null;
export function getTracker(): TokenTracker {
  if (!_tracker) _tracker = new TokenTracker();
  return _tracker;
}
