import type { BudgetConfig } from '../util/config.js';
import type { TokenTracker } from './tracker.js';
import { getLogger } from '../util/logger.js';

export type BudgetLevel = 'ok' | 'caution' | 'low' | 'exhausted';

export interface BudgetSnapshot {
  level: BudgetLevel;
  daily: { used: number; limit: number; remaining: number; pct: number };
  weekly: { used: number; limit: number; remaining: number; pct: number };
  safetyPad: number;
  byProvider: Record<string, number>;
  recommendation: 'continue' | 'small_tasks_only' | 'pause' | 'stop';
  asOf: string;
}

export class BudgetPolicy {
  private log = getLogger('budget');

  constructor(
    public readonly config: BudgetConfig,
    public readonly tracker: TokenTracker
  ) {}

  snapshot(): BudgetSnapshot {
    const d = this.tracker.dailyUsage();
    const w = this.tracker.weeklyUsage();
    const dailyUsed = d.total;
    const weeklyUsed = w.total;
    const dailyRemaining = Math.max(0, this.config.dailyLimitTokens - dailyUsed);
    const weeklyRemaining = Math.max(0, this.config.weeklyLimitTokens - weeklyUsed);
    const effectiveRemaining = Math.min(dailyRemaining, weeklyRemaining);
    const pad = this.config.safetyPadTokens;

    let level: BudgetLevel;
    let recommendation: BudgetSnapshot['recommendation'];
    if (effectiveRemaining <= 0) {
      level = 'exhausted';
      recommendation = 'stop';
    } else if (effectiveRemaining <= pad) {
      level = 'exhausted';
      recommendation = 'stop';
    } else if (effectiveRemaining <= pad * 4) {
      level = 'low';
      recommendation = 'pause';
    } else if (effectiveRemaining <= pad * 12) {
      level = 'caution';
      recommendation = 'small_tasks_only';
    } else {
      level = 'ok';
      recommendation = 'continue';
    }

    return {
      level,
      daily: {
        used: dailyUsed,
        limit: this.config.dailyLimitTokens,
        remaining: dailyRemaining,
        pct: this.config.dailyLimitTokens
          ? (dailyUsed / this.config.dailyLimitTokens) * 100
          : 0,
      },
      weekly: {
        used: weeklyUsed,
        limit: this.config.weeklyLimitTokens,
        remaining: weeklyRemaining,
        pct: this.config.weeklyLimitTokens
          ? (weeklyUsed / this.config.weeklyLimitTokens) * 100
          : 0,
      },
      safetyPad: pad,
      byProvider: { ...d.byProvider, ...w.byProvider },
      recommendation,
      asOf: new Date().toISOString(),
    };
  }

  canRunTask(estimatedTokens: number): { ok: boolean; reason?: string } {
    const snap = this.snapshot();
    if (snap.recommendation === 'stop') {
      return {
        ok: false,
        reason: `budget ${snap.level}: remaining ${Math.min(
          snap.daily.remaining,
          snap.weekly.remaining
        )} <= pad ${this.config.safetyPadTokens}`,
      };
    }
    if (estimatedTokens > this.config.perTaskEstimateCap) {
      return {
        ok: false,
        reason: `estimate ${estimatedTokens} exceeds per-task cap ${this.config.perTaskEstimateCap}; split or approve`,
      };
    }
    const remaining = Math.min(snap.daily.remaining, snap.weekly.remaining);
    if (estimatedTokens + this.config.safetyPadTokens > remaining) {
      return {
        ok: false,
        reason: `estimate ${estimatedTokens} + pad ${this.config.safetyPadTokens} > remaining ${remaining}`,
      };
    }
    if (snap.recommendation === 'pause' && estimatedTokens > this.config.safetyPadTokens) {
      return {
        ok: false,
        reason: `paused (low budget), only tiny tasks allowed`,
      };
    }
    return { ok: true };
  }

  reactToLowBudget(snap: BudgetSnapshot): void {
    for (const action of this.config.onLowBudget) {
      switch (action) {
        case 'log':
          this.log.warn({ level: snap.level }, 'low budget triggered');
          break;
        case 'pause':
          this.log.warn('daemon pausing big-task intake due to low budget');
          break;
        case 'notify_cli':
          this.log.warn('CLI will be notified on next status call');
          break;
        default:
          this.log.warn({ action }, 'unknown onLowBudget action');
      }
    }
  }
}
