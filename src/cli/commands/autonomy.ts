import chalk from 'chalk';
import { findProject } from '../../projects/scanner.js';
import { scanProject, FULL_ENABLED, MEDIUM_ENABLED, DEFAULT_ENABLED } from '../../scanners/index.js';
import * as queue from '../../supervisor/queue.js';
import { loadConfig } from '../../util/config.js';
import { HealthProbe } from '../../providers/health.js';
import { Autonomy, readRecentCycles, type Aggressiveness } from '../../supervisor/autonomy.js';
import { Supervisor } from '../../daemon/supervisor.js';

export async function runQueue(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'list':
      return listQueue(args);
    case 'stats':
      return queueStats();
    case 'show':
      return showQueue(args[0]);
    case 'drop':
      return dropQueue(args[0]);
    case 'clear':
      return clearQueue(args);
    case 'pick':
      return pickQueue(args);
    default:
      console.log(chalk.red(`unknown action: ${action}`));
      console.log(chalk.gray('usage: overseer queue <list [--project X] | stats | show <id> | drop <id> | clear [--project X] | pick [--project X]>'));
      process.exit(2);
  }
}

function listQueue(args: string[]): void {
  const pIdx = args.indexOf('--project');
  const project = pIdx >= 0 ? args[pIdx + 1] : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 30;
  const items = queue.list({ project, limit });
  if (items.length === 0) {
    console.log(chalk.gray(project ? `no queue items for ${project}` : 'queue is empty; run "overseer cycle run" to scan'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== 队列 ${items.length} 条${project ? ` (${project})` : ''} ===\n`));
  for (const i of items) {
    const sev = sevColor(i.severity)(i.severity.padEnd(8));
    console.log(`  ${sev}  [${i.source}/${i.category}] ${chalk.bold(i.title)}`);
    console.log(chalk.gray(`       id=${i.id}  project=${i.project}  status=${i.status}  last=${i.lastSeen}`));
  }
  console.log();
}

function queueStats(): void {
  const s = queue.stats();
  console.log(chalk.bold.cyan(`\n=== queue stats ===\n`));
  console.log(`total: ${chalk.green(String(s.total))}\n`);
  console.log(chalk.bold('by status:'));
  for (const k of Object.keys(s.byStatus).sort()) console.log(`  ${k.padEnd(20)} ${s.byStatus[k]}`);
  console.log(chalk.bold('\nby severity:'));
  for (const k of ['critical', 'high', 'medium', 'low']) {
    if (s.bySeverity[k]) console.log(`  ${k.padEnd(20)} ${s.bySeverity[k]}`);
  }
  console.log(chalk.bold('\nby project:'));
  for (const k of Object.keys(s.byProject).sort()) console.log(`  ${k.padEnd(20)} ${s.byProject[k]}`);
  console.log(chalk.bold('\nby source:'));
  for (const k of Object.keys(s.bySource).sort()) console.log(`  ${k.padEnd(20)} ${s.bySource[k]}`);
  console.log();
}

function showQueue(id?: string): void {
  if (!id) {
    console.log(chalk.red('usage: overseer queue show <id>'));
    process.exit(2);
  }
  const item = queue.getById(id);
  if (!item) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  console.log(chalk.bold.cyan(`\n=== ${item.title} ===\n`));
  console.log(`id:          ${item.id}`);
  console.log(`dedupe:      ${item.dedupe}`);
  console.log(`project:     ${item.project}`);
  console.log(`source:      ${item.source}`);
  console.log(`category:    ${item.category}`);
  console.log(`severity:    ${sevColor(item.severity)(item.severity)}`);
  console.log(`status:      ${item.status}`);
  console.log(`first seen:  ${item.firstSeen}`);
  console.log(`last seen:   ${item.lastSeen}`);
  if (item.intentionId) console.log(`intention:   ${item.intentionId}`);
  if (item.files?.length) console.log(`files:       ${item.files.join(', ')}`);
  console.log(`\n${item.detail}`);
  if (item.hint) console.log(chalk.gray(`\nhint: ${item.hint}`));
  console.log();
}

function dropQueue(id?: string): void {
  if (!id) {
    console.log(chalk.red('usage: overseer queue drop <id>'));
    process.exit(2);
  }
  const ok = queue.drop(id);
  console.log(ok ? chalk.green(`dropped ${id}`) : chalk.red(`not found: ${id}`));
}

function clearQueue(args: string[]): void {
  const pIdx = args.indexOf('--project');
  const project = pIdx >= 0 ? args[pIdx + 1] : undefined;
  const n = queue.clear(project);
  console.log(chalk.green(`cleared ${n} item(s)${project ? ` from ${project}` : ''}`));
}

function pickQueue(args: string[]): void {
  const pIdx = args.indexOf('--project');
  const project = pIdx >= 0 ? args[pIdx + 1] : undefined;
  const item = queue.pickNext(project);
  if (!item) {
    console.log(chalk.gray('queue empty'));
    return;
  }
  console.log(chalk.bold.cyan(`\nnext: ${item.title}\n`));
  console.log(chalk.gray(JSON.stringify({ id: item.id, project: item.project, severity: item.severity }, null, 2)));
  console.log();
}

export async function runCycle(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'run':
      return cycleRun(args);
    case 'log':
      return cycleLog(args);
    case 'scan':
      return cycleScan(args);
    default:
      console.log(chalk.red(`unknown action: ${action}`));
      console.log(chalk.gray('usage: overseer cycle <run [--aggressiveness light|normal|full] [--project X] [--auto-execute] [--allow-shell]> | log [--limit N]> | scan <project>'));
      process.exit(2);
  }
}

async function cycleRun(args: string[]): Promise<void> {
  const flagAgg = argValue(args, '--aggressiveness') as Aggressiveness | undefined;
  const project = argValue(args, '--project');
  const autoExecute = args.includes('--auto-execute');
  const allowShell = args.includes('--allow-shell');

  const sup = new Supervisor();
  const autonomy = new Autonomy({
    router: sup.router,
    modePolicy: sup.modePolicy,
    budget: sup.budget,
    writer: sup.writer,
    currentMode: () => sup.mode,
    recomputeMode: () => sup.recomputeMode(),
  });

  console.log(chalk.bold.cyan('\n=== 启动一轮自主巡检 ===\n'));
  const out = await autonomy.runCycle({
    aggressiveness: flagAgg ?? 'normal',
    autoExecute,
    allowShellDuringScan: allowShell,
    onlyProjects: project ? [project] : [],
  });
  console.log(`mode:           ${out.mode}`);
  console.log(`projects:       ${out.projects.length}`);
  for (const p of out.projects) {
    console.log(`  ${chalk.bold(p.id.padEnd(16))} ${p.durationMs}ms  scanners: ${JSON.stringify(p.perScanner)}`);
    if (Object.keys(p.errors).length > 0) console.log(chalk.gray(`    errors: ${JSON.stringify(p.errors)}`));
  }
  console.log(`queue:          ${out.queueBefore} → ${chalk.green(String(out.queueAfter))}  (+${out.added} added, ~${out.updated} updated, -${out.pruned} pruned)`);
  if (out.executed) {
    console.log(`executed:       ${out.executed.queueId} → ${out.executed.status}`);
    if (out.executed.designNote) console.log(chalk.green(`  design: [[${out.executed.designNote}]]`));
    if (out.executed.error) console.log(chalk.red(`  error: ${out.executed.error}`));
  }
  console.log();
}

function cycleLog(args: string[]): void {
  const limit = Number(argValue(args, '--limit') ?? 10);
  const cycles = readRecentCycles(limit);
  if (cycles.length === 0) {
    console.log(chalk.gray('no cycles yet'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== 最近 ${cycles.length} 轮 ===\n`));
  for (const c of cycles) {
    console.log(`  ${c.startedAt}  mode=${c.mode}  projects=${c.projects.length}  +${c.added} ~${c.updated}  queue=${c.queueAfter}  ${c.executed ? `✓exec=${c.executed.queueId}` : ''}`);
  }
  console.log();
}

async function cycleScan(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.log(chalk.red('usage: overseer cycle scan <project> [--aggressiveness light|normal|full] [--allow-shell]'));
    process.exit(2);
  }
  const project = findProject(id);
  if (!project) {
    console.log(chalk.red(`project not found: ${id}`));
    process.exit(1);
  }
  const agg = (argValue(args, '--aggressiveness') ?? 'normal') as Aggressiveness;
  const allowShell = args.includes('--allow-shell');
  const enabled = agg === 'light' ? DEFAULT_ENABLED : agg === 'full' ? FULL_ENABLED : MEDIUM_ENABLED;
  console.log(chalk.bold.cyan(`\n=== 扫描 ${project.id} (${agg}) ===\n`));
  const r = await scanProject(project, { enabledScanners: enabled, allowShell, limitPerScanner: 5 });
  console.log(`duration: ${r.durationMs}ms`);
  console.log(`perScanner: ${JSON.stringify(r.perScanner)}`);
  if (Object.keys(r.errors).length > 0) console.log(chalk.gray(`errors: ${JSON.stringify(r.errors)}`));
  console.log(`\nseeds: ${r.seeds.length}`);
  for (const s of r.seeds) {
    const sev = sevColor(s.severity)(s.severity.padEnd(8));
    console.log(`  ${sev}  [${s.source}/${s.category}] ${chalk.bold(s.title)}`);
    console.log(chalk.gray(`       key=${s.key}`));
  }
  console.log();
}

export async function runHealth(): Promise<void> {
  const cfg = loadConfig();
  const probe = new HealthProbe(cfg, 0); // 0 = 强制刷新
  console.log(chalk.bold.cyan('\n=== provider health ===\n'));
  const ids = Object.keys(cfg.providers);
  const all: Awaited<ReturnType<typeof probe.checkProvider>>[] = [];
  for (const id of ids) {
    all.push(await probe.checkProvider(id, true));
  }
  if (all.length === 0) {
    console.log(chalk.gray('no providers configured'));
    return;
  }
  for (const h of all) {
    const status = h.reachable
      ? chalk.green('reachable')
      : h.ready
      ? chalk.yellow('configured but unreachable')
      : chalk.gray('not ready');
    console.log(`  ${h.id.padEnd(12)} ${status}  latency=${h.latencyMs ?? '-'}ms  models=${h.models?.length ?? '-'}`);
    if (h.error) console.log(chalk.gray(`       error: ${h.error}`));
    if (h.models && h.models.length > 0) {
      console.log(chalk.gray(`       first few: ${h.models.slice(0, 5).join(', ')}${h.models.length > 5 ? ' ...' : ''}`));
    }
  }
  const usable = await probe.fallbackUsable();
  console.log(`\nfallback usable: ${usable ? chalk.green('yes') : chalk.gray('no')}`);
  console.log();
}

function argValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function sevColor(s: string): (t: string) => string {
  if (s === 'critical') return chalk.red;
  if (s === 'high') return chalk.magenta;
  if (s === 'medium') return chalk.yellow;
  return chalk.gray;
}
