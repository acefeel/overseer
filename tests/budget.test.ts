import { describe, it, expect } from 'vitest';
import { BudgetPolicy } from '../src/budget/policy.js';
import type { TokenTracker } from '../src/budget/tracker.js';

const cfg = {
  dailyLimitTokens: 5_000_000,
  weeklyLimitTokens: 35_000_000,
  safetyPadTokens: 200_000,
  perTaskEstimateCap: 800_000,
  useQuotaApi: true,
  rollingWindowHours: 24,
  onLowBudget: ['log', 'pause', 'notify_cli'],
};

function makeTracker(daily: number, weekly: number): TokenTracker {
  return {
    dailyUsage: () => ({ prompt: daily, completion: 0, total: daily, byProvider: {} }),
    weeklyUsage: () => ({ prompt: weekly, completion: 0, total: weekly, byProvider: {} }),
  } as TokenTracker;
}

describe('BudgetPolicy.snapshot', () => {
  it('剩余充足 → ok / continue', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(0, 0));
    const s = policy.snapshot();
    expect(s.level).toBe('ok');
    expect(s.recommendation).toBe('continue');
  });

  it('剩余在 caution 区间 → caution / small_tasks_only', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(2_600_000, 0));
    const s = policy.snapshot();
    expect(s.level).toBe('caution');
    expect(s.recommendation).toBe('small_tasks_only');
  });

  it('剩余在 low 区间 → low / pause', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(4_200_000, 0));
    const s = policy.snapshot();
    expect(s.level).toBe('low');
    expect(s.recommendation).toBe('pause');
  });

  it('剩余小于等于 pad → exhausted / stop', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(4_850_000, 0));
    const s = policy.snapshot();
    expect(s.level).toBe('exhausted');
    expect(s.recommendation).toBe('stop');
  });

  it('周窗口先耗尽时仍触发 stop', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(0, 34_900_000));
    const s = policy.snapshot();
    expect(s.recommendation).toBe('stop');
    expect(s.level).toBe('exhausted');
  });
});

describe('BudgetPolicy.canRunTask', () => {
  it('正常预算允许普通任务', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(0, 0));
    expect(policy.canRunTask(100_000).ok).toBe(true);
  });

  it('超过 per-task cap 拒绝', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(0, 0));
    const r = policy.canRunTask(1_000_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('per-task cap');
  });

  it('预算耗尽拒绝', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(5_000_000, 0));
    const r = policy.canRunTask(100);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('budget');
  });

  it('estimate + pad 超过剩余拒绝', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(4_500_000, 0));
    const r = policy.canRunTask(400_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('remaining');
  });

  it('low 预算只允许不超过 pad 的小任务', () => {
    const policy = new BudgetPolicy(cfg, makeTracker(4_200_000, 0));
    expect(policy.canRunTask(100_000).ok).toBe(true);
    const r = policy.canRunTask(300_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tiny tasks');
  });
});
