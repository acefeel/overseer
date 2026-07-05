import { ModePolicy } from '../dist/daemon/mode.js';
import { Router } from '../dist/providers/router.js';
import { loadConfig } from '../dist/util/config.js';

const policy = new ModePolicy();

function snap(level, daily, weekly, pad = 200000) {
  return {
    level,
    daily: { used: daily, limit: 5000000, remaining: 5000000 - daily, pct: 0 },
    weekly: { used: weekly, limit: 35000000, remaining: 35000000 - weekly, pct: 0 },
    safetyPad: pad,
    byProvider: {},
    recommendation: level === 'ok' ? 'continue' : level === 'exhausted' ? 'stop' : 'pause',
    asOf: new Date().toISOString(),
  };
}

const cases = [
  // 主控可用场景
  { name: 'mainReady + ok, no fallback', snap: snap('ok', 0, 0), mainReady: true, fb: false, want: 'normal' },
  { name: 'mainReady + caution, no fallback', snap: snap('caution', 100000, 1000000), mainReady: true, fb: false, want: 'normal' },
  { name: 'mainReady + low, no fallback', snap: snap('low', 4900000, 30000000), mainReady: true, fb: false, want: 'stopped' },
  { name: 'mainReady + exhausted, no fallback', snap: snap('exhausted', 4999999, 34999999), mainReady: true, fb: false, want: 'stopped' },
  { name: 'mainReady + low, has fallback', snap: snap('low', 4900000, 30000000), mainReady: true, fb: true, want: 'degraded' },
  { name: 'mainReady + exhausted, has fallback', snap: snap('exhausted', 4999999, 34999999), mainReady: true, fb: true, want: 'degraded' },
  // 主控不可用场景（新逻辑核心）
  { name: 'NO main + ok, has fallback', snap: snap('ok', 0, 0), mainReady: false, fb: true, want: 'degraded' },
  { name: 'NO main + exhausted, has fallback', snap: snap('exhausted', 4999999, 34999999), mainReady: false, fb: true, want: 'degraded' },
  { name: 'NO main + ok, NO fallback', snap: snap('ok', 0, 0), mainReady: false, fb: false, want: 'stopped' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = policy.decide(c.snap, c.mainReady, c.fb);
  const ok = got.mode === c.want;
  console.log(`${ok ? '✓' : '✗'} ${c.name.padEnd(40)} → got=${got.mode}(${got.trigger}) want=${c.want}`);
  if (ok) pass++; else fail++;
}

console.log('\n--- ActionPolicy (degraded) ---');
const actions = ['read', 'chat', 'retrieve', 'status', 'memory.write', 'file.write', 'git.commit', 'shell.exec', 'file.delete'];
for (const a of actions) {
  const normalR = policy.canPerform(a, 'normal');
  const degrR = policy.canPerform(a, 'degraded');
  const stopR = policy.canPerform(a, 'stopped');
  console.log(
    `  ${a.padEnd(16)} normal=${normalR.ok ? 'Y' : 'N'}  degraded=${degrR.ok ? 'Y' : 'N'}  stopped=${stopR.ok ? 'Y' : 'N'}`
  );
}

console.log('\n--- Router with local fallback disabled (default config) ---');
const cfg1 = loadConfig({ force: true });
const r1 = new Router(cfg1);
console.log(`  chain=${JSON.stringify(r1.activeChain)} fallback=${r1.fallbackProviderId ?? 'null'} hasFallback=${r1.hasFallback()}`);

console.log('\n--- Router after forcing local.enabled=true ---');
const cfg2 = JSON.parse(JSON.stringify(cfg1));
cfg2.providers.local.enabled = true;
const r2 = new Router(cfg2);
console.log(`  chain=${JSON.stringify(r2.activeChain)} fallback=${r2.fallbackProviderId ?? 'null'} hasFallback=${r2.hasFallback()}`);
console.log(`  local provider:`, r2.listProviders().find((p) => p.id === 'local'));

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
