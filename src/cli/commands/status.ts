import chalk from 'chalk';
import { loadConfig } from '../../util/config.js';
import { getTracker } from '../../budget/tracker.js';
import { BudgetPolicy } from '../../budget/policy.js';
import { Router } from '../../providers/router.js';
import { ModePolicy } from '../../daemon/mode.js';

const LEVEL_COLOR: Record<string, (s: string) => string> = {
  ok: chalk.green,
  caution: chalk.yellow,
  low: chalk.magenta,
  exhausted: chalk.red,
};

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function bar(used: number, limit: number, width = 24): string {
  const pct = limit ? Math.min(1, used / limit) : 0;
  const filled = Math.round(width * pct);
  return (
    '[' +
    '#'.repeat(filled) +
    '-'.repeat(width - filled) +
    '] ' +
    (pct * 100).toFixed(1) +
    '%'
  );
}

export async function runStatus(): Promise<void> {
  const cfg = loadConfig();
  const router = new Router(cfg);
  const policy = new BudgetPolicy(cfg.budget, getTracker());
  const snap = policy.snapshot();

  console.log(chalk.bold.cyan('\n=== overSeer status ===\n'));

  console.log(chalk.bold('Providers:'));
  for (const p of router.listProviders()) {
    let tag: string;
    if (!p.ready) tag = chalk.gray('off');
    else if (p.role === 'fallback') tag = chalk.magenta('fallback');
    else tag = chalk.green('ready');
    const inChain = router.activeChain.includes(p.id)
      ? chalk.cyan(' [main]')
      : router.fallbackProviderId === p.id
      ? chalk.magenta(' [fallback]')
      : '';
    const act = p.canAct ? '' : chalk.gray(' (read-only)');
    console.log(
      `  ${tag}  ${p.id.padEnd(12)} ${p.kind.padEnd(12)} ${p.model.padEnd(22)}${inChain}${act}`
    );
  }
  console.log();

  console.log(chalk.bold('Token budget:'));
  const color = LEVEL_COLOR[snap.level] ?? chalk.white;
  console.log(`  level:     ${color(snap.level)}  →  recommendation: ${snap.recommendation}`);
  console.log(`  today:     ${bar(snap.daily.used, snap.daily.limit)}   ${fmt(snap.daily.used)} / ${fmt(snap.daily.limit)} tokens`);
  console.log(`  week:      ${bar(snap.weekly.used, snap.weekly.limit)}   ${fmt(snap.weekly.used)} / ${fmt(snap.weekly.limit)} tokens`);
  console.log(`  pad:       ${fmt(cfg.budget.safetyPadTokens)}`);
  console.log(`  as of:     ${snap.asOf}`);
  console.log();

  console.log(chalk.bold('Supervision mode:'));
  const modePolicy = new ModePolicy();
  const localDecision = modePolicy.decide(snap, router.mainChainReady(), router.hasFallback());
  try {
    const { IpcClient } = await import('../../daemon/ipc.js');
    const client = new IpcClient(cfg.daemon.ipcName);
    const alive = await client.isAlive();
    if (alive) {
      const st = await client.request('status') as { mode: string; fallback: string | null };
      const modeColor =
        st.mode === 'normal'
          ? chalk.green
          : st.mode === 'degraded'
          ? chalk.magenta
          : chalk.red;
      console.log(`  mode:      ${modeColor(st.mode)}`);
      console.log(`  fallback:  ${st.fallback ?? chalk.gray('(none)')}`);
    } else {
      const modeColor =
        localDecision.mode === 'normal'
          ? chalk.green
          : localDecision.mode === 'degraded'
          ? chalk.magenta
          : chalk.red;
      console.log(`  mode:      ${modeColor(localDecision.mode)}  ${chalk.gray('(computed locally, daemon not running)')}`);
      console.log(`  trigger:   ${chalk.gray(localDecision.trigger)}`);
      console.log(`  reason:    ${chalk.gray(localDecision.reason)}`);
      console.log(`  fallback:  ${router.fallbackProviderId ?? chalk.gray('(none)')}`);
    }
  } catch (e) {
    console.log(`  ${chalk.gray('not reachable')}: ${(e as Error).message}`);
  }
  console.log();

  const byP = snap.byProvider;
  const keys = Object.keys(byP);
  if (keys.length > 0) {
    console.log(chalk.bold('Used by provider (today+week window):'));
    for (const k of keys) {
      console.log(`  ${k.padEnd(12)} ${fmt(byP[k])} tokens`);
    }
    console.log();
  }

  console.log(chalk.bold('Daemon:'));
  try {
    const { IpcClient } = await import('../../daemon/ipc.js');
    const client = new IpcClient(cfg.daemon.ipcName);
    const alive = await client.isAlive();
    console.log(`  ${alive ? chalk.green('running') : chalk.gray('not running')}`);
    if (alive) {
      const ping = await client.request('ping') as { ts: string };
      console.log(`  pid ts:    ${ping.ts}`);
    }
  } catch (e) {
    console.log(`  ${chalk.gray('not reachable')}: ${(e as Error).message}`);
  }
  console.log();
}
