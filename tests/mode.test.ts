import { describe, it, expect } from 'vitest';
import { ModePolicy } from '../src/daemon/mode.js';

const policy = new ModePolicy();

function snap(level, daily, weekly, pad = 200000) {
  return {
    level,
    daily: { used: daily, limit: 5_000_000, remaining: 5_000_000 - daily, pct: 0 },
    weekly: { used: weekly, limit: 35_000_000, remaining: 35_000_000 - weekly, pct: 0 },
    safetyPad: pad,
    byProvider: {},
    recommendation: level === 'ok' ? 'continue' : level === 'exhausted' ? 'stop' : 'pause',
    asOf: new Date().toISOString(),
  };
}

describe('ModePolicy.decide', () => {
  const cases = [
    { name: 'main ready + ok, no fallback', snap: snap('ok', 0, 0), mainReady: true, fb: false, want: { mode: 'normal', trigger: 'normal' } },
    { name: 'main ready + caution, no fallback', snap: snap('caution', 100_000, 1_000_000), mainReady: true, fb: false, want: { mode: 'normal', trigger: 'normal' } },
    { name: 'main ready + low, no fallback', snap: snap('low', 4_900_000, 30_000_000), mainReady: true, fb: false, want: { mode: 'stopped', trigger: 'no-fallback' } },
    { name: 'main ready + exhausted, no fallback', snap: snap('exhausted', 4_999_999, 34_999_999), mainReady: true, fb: false, want: { mode: 'stopped', trigger: 'no-fallback' } },
    { name: 'main ready + low, has fallback', snap: snap('low', 4_900_000, 30_000_000), mainReady: true, fb: true, want: { mode: 'degraded', trigger: 'budget' } },
    { name: 'main ready + exhausted, has fallback', snap: snap('exhausted', 4_999_999, 34_999_999), mainReady: true, fb: true, want: { mode: 'degraded', trigger: 'budget' } },
    { name: 'NO main + ok, has fallback', snap: snap('ok', 0, 0), mainReady: false, fb: true, want: { mode: 'degraded', trigger: 'no-main' } },
    { name: 'NO main + exhausted, has fallback', snap: snap('exhausted', 4_999_999, 34_999_999), mainReady: false, fb: true, want: { mode: 'degraded', trigger: 'no-main' } },
    { name: 'NO main + ok, NO fallback', snap: snap('ok', 0, 0), mainReady: false, fb: false, want: { mode: 'stopped', trigger: 'no-fallback' } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const got = policy.decide(c.snap, c.mainReady, c.fb);
      expect(got.mode).toBe(c.want.mode);
      expect(got.trigger).toBe(c.want.trigger);
    });
  }
});

describe('ModePolicy.canPerform', () => {
  it('normal 模式允许所有动作', () => {
    for (const action of ['read', 'chat', 'file.write', 'file.delete', 'shell.exec', 'git.push'] as const) {
      expect(policy.canPerform(action, 'normal').ok).toBe(true);
    }
  });

  it('degraded 模式允许所有动作', () => {
    for (const action of ['read', 'chat', 'file.write', 'file.delete', 'shell.exec', 'git.push'] as const) {
      expect(policy.canPerform(action, 'degraded').ok).toBe(true);
    }
  });

  it('stopped 模式拒绝所有动作', () => {
    for (const action of ['read', 'chat', 'file.write', 'shell.exec'] as const) {
      expect(policy.canPerform(action, 'stopped').ok).toBe(false);
    }
  });
});
