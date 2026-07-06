import chalk from 'chalk';
import { Supervisor } from '../../daemon/supervisor.js';
import {
  PdcaeLoop,
  readAllIntentions,
  readPendingIntentions,
} from '../../supervisor/loop.js';
import { listSnapshots, readSnapshot } from '../../vcs/snapshot.js';
import { ProjectGit } from '../../vcs/git.js';
import { Rollback } from '../../vcs/rollback.js';
import { findProject } from '../../projects/scanner.js';
import * as approvals from '../../supervisor/approvals.js';
import { fulfill } from '../../supervisor/fulfill.js';

export async function runSupervise(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'plan':
      return plan(args);
    case 'intentions':
      return listIntentions(args);
    case 'intention':
      return showIntention(args[0]);
    case 'develop':
      return develop(args);
    case 'snapshots':
      return listSnaps();
    case 'snapshot':
      return showSnap(args[0]);
    case 'rollback':
      return rollback(args[0]);
    case 'approvals':
      return listApprovals();
    case 'approve':
      return decideApproval(args[0], 'approved');
    case 'reject':
      return decideApproval(args[0], 'rejected');
    default:
      console.log(chalk.red(`unknown supervise action: ${action}`));
      console.log(
        chalk.gray(
          'usage: overseer supervise <plan <project> [hint] | intentions [project] | intention <id> | develop <id> | snapshots | snapshot <id> | rollback <id> | approvals | approve <id> | reject <id>>'
        )
      );
      process.exit(2);
  }
}

function buildLoop(): PdcaeLoop {
  const sup = new Supervisor();
  return new PdcaeLoop(
    sup.router,
    sup.modePolicy,
    () => sup.mode,
    sup.writer,
    (est: number) => sup.budget.canRunTask(est)
  );
}

async function plan(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const projectId = positional[0];
  const hint = positional.slice(1).join(' ');
  if (!projectId) {
    console.log(chalk.red('usage: overseer supervise plan <project> [hint...]'));
    process.exit(2);
  }
  const loop = buildLoop();
  const result = await loop.plan(projectId, hint || undefined);
  if (result.status === 'failed') {
    console.log(chalk.red(`\n✗ ${result.error}\n`));
    process.exit(1);
  }
  if (result.status === 'skipped') {
    console.log(chalk.yellow(`\nskipped: ${JSON.stringify(result.detail)}\n`));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== 生成 ${result.intentions?.length ?? 0} 个意向 ===\n`));
  for (const i of result.intentions ?? []) {
    const sev = severityColor(i.severity)(i.severity);
    console.log(`  ${sev}  [${i.category}] ${chalk.bold(i.title)}`);
    console.log(chalk.gray(`       id=${i.id}  est=${i.estimatedTokens}t  risks=${i.risks.length}`));
    console.log(chalk.gray(`       ${i.rationale.replace(/\n/g, ' ').slice(0, 160)}`));
  }
  if (result.planNoteRel) {
    console.log(chalk.green(`\n📝 plan note: [[${result.planNoteRel}]]\n`));
  }
}

function listIntentions(args: string[]): void {
  const project = args.find((a) => !a.startsWith('--'));
  const all = readPendingIntentions(project);
  if (all.length === 0) {
    console.log(chalk.gray(project ? `no intentions for ${project}` : 'no intentions; run "overseer supervise plan <project>"'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== ${all.length} 个意向${project ? ` (${project})` : ''} ===\n`));
  for (const i of all) {
    const sev = severityColor(i.severity)(i.severity);
    console.log(`  ${sev}  [${i.category}] ${chalk.bold(i.title)}`);
    console.log(chalk.gray(`       id=${i.id}  project=${i.project}  est=${i.estimatedTokens}t`));
    console.log(chalk.gray(`       ${i.proposedAction.replace(/\n/g, ' ').slice(0, 160)}`));
  }
  console.log();
}

function showIntention(id?: string): void {
  if (!id) {
    console.log(chalk.red('usage: overseer supervise intention <id>'));
    process.exit(2);
  }
  const all = readAllIntentions();
  const i = all.find((x) => x.id === id);
  if (!i) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  console.log(chalk.bold.cyan(`\n=== ${i.title} ===\n`));
  console.log(`id:           ${i.id}`);
  console.log(`project:      ${i.project}`);
  console.log(`category:     ${i.category}`);
  console.log(`severity:     ${severityColor(i.severity)(i.severity)}`);
  console.log(`est. tokens:  ${i.estimatedTokens}`);
  console.log(`source:       ${i.source}`);
  console.log(`created:      ${i.createdAt}`);
  console.log(`\nrational:\n${i.rationale}`);
  console.log(`\nproposed action:\n${i.proposedAction}`);
  console.log(`\nrisks:`);
  for (const r of i.risks) console.log(`  - ${r}`);
  console.log();
}

async function develop(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.log(chalk.red('usage: overseer supervise develop <intentionId> [--execute]'));
    process.exit(2);
  }
  const execute = args.includes('--execute');
  const loop = buildLoop();
  const result: any = execute
    ? await loop.develop(id, false)
    : await loop.executeIntention(id);
  if (result.status === 'failed') {
    console.log(chalk.red(`\n✗ ${result.error}\n`));
    process.exit(1);
  }
  console.log(chalk.bold.cyan(`\n=== ${result.phase} → ${result.status} ===\n`));
  if (result.error) console.log(chalk.gray(`note: ${result.error}`));

  // codegen 输出（develop --execute 才有）
  if (result.codegenSummary) {
    console.log(chalk.bold('codegen summary:'));
    console.log(chalk.gray(result.codegenSummary));
    console.log();
  }
  if (result.applied && result.applied.length > 0) {
    console.log(chalk.bold('应用的改动：'));
    for (const a of result.applied) {
      const flag = a.ok ? chalk.green('✓') : chalk.red('✗');
      const snap = a.snapshotId ? chalk.gray(` (snap ${a.snapshotId})`) : '';
      const err = a.error ? chalk.red(` — ${a.error}`) : '';
      console.log(`  ${flag} ${chalk.yellow(a.action.padEnd(8))} ${a.path}${snap}${err}`);
    }
    console.log();
  }
  if (result.rejected && result.rejected.length > 0) {
    console.log(chalk.bold('被拒的改动：'));
    for (const r of result.rejected) {
      console.log(chalk.gray(`  ✗ ${r.change.path} (${r.change.action}) — ${r.reason}`));
    }
    console.log();
  }
  if (result.testRun) {
    const flag = result.testRun.ok ? chalk.green('✓ pass') : chalk.red(`✗ fail (exit ${result.testRun.code})`);
    console.log(`${chalk.bold('测试:')} ${flag}  ${chalk.gray(result.testRun.command)}`);
    console.log();
  }
  if (result.designNoteRel) console.log(chalk.green(`📝 design: [[${result.designNoteRel}]]`));
  if (result.retroNoteRel) console.log(chalk.green(`📝 retro:  [[${result.retroNoteRel}]]`));
  if (result.snapshotId) {
    console.log(chalk.yellow(`rollback: overseer supervise rollback ${result.snapshotId}`));
  }
  if (result.detail) console.log(chalk.gray(`detail: ${JSON.stringify(result.detail)}`));
  console.log();
}

function listSnaps(): void {
  const snaps = listSnapshots();
  if (snaps.length === 0) {
    console.log(chalk.gray('no snapshots'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== ${snaps.length} 个快照 ===\n`));
  for (const s of snaps) {
    console.log(`  ${chalk.yellow(s.id)}  ${s.projectId}/${s.branch ?? '-'}  head=${(s.headSha ?? '-').slice(0, 8)}  stashed=${s.stashed}`);
    console.log(chalk.gray(`    ${s.reason}  ·  ${s.createdAt}`));
  }
  console.log();
}

function showSnap(id?: string): void {
  if (!id) {
    console.log(chalk.red('usage: overseer supervise snapshot <id>'));
    process.exit(2);
  }
  const s = readSnapshot(id);
  if (!s) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  console.log(chalk.bold.cyan(`\n=== ${s.id} ===\n`));
  console.log(chalk.gray(JSON.stringify(s, null, 2)));
  console.log();
}

async function rollback(id?: string): Promise<void> {
  if (!id) {
    console.log(chalk.red('usage: overseer supervise rollback <snapshotId>'));
    process.exit(2);
  }
  const snap = readSnapshot(id);
  if (!snap) {
    console.log(chalk.red(`snapshot not found: ${id}`));
    process.exit(1);
  }
  const p = findProject(snap.projectId);
  if (!p) {
    console.log(chalk.red(`project ${snap.projectId} not in workspace anymore`));
    process.exit(1);
  }
  const git = new ProjectGit(p.rootAbs);
  const rb = new Rollback(git);
  const r = await rb.to(id);
  if (r.ok) {
    console.log(chalk.green(`\n✓ rolled back ${snap.projectId} to ${snap.id}`));
    console.log(chalk.gray(`   reset commits: ${r.resetCommits}, restored stash: ${r.restoredStash}\n`));
  } else {
    console.log(chalk.red(`\n✗ ${r.error}\n`));
    process.exit(1);
  }
}

function listApprovals(): void {
  const pending = approvals.listPending();
  const recent = approvals.listAll().slice(0, 10).filter((a) => a.status !== 'pending');
  console.log(chalk.bold.cyan(`\n=== 待批准 (${pending.length}) ===\n`));
  if (pending.length === 0) console.log(chalk.gray('  (none)'));
  for (const a of pending) {
    console.log(`  ${chalk.yellow(a.id)}  [${a.action}] ${a.description}`);
    console.log(chalk.gray(`    project=${a.project}  ts=${a.ts}`));
  }
  if (recent.length > 0) {
    console.log(chalk.bold.cyan(`\n=== 最近决策 ===\n`));
    for (const a of recent) {
      const c = a.status === 'approved' ? chalk.green : chalk.red;
      console.log(`  ${c(a.status.padEnd(8))} ${a.id}  ${a.description}`);
    }
  }
  console.log();
}

async function decideApproval(id: string, status: 'approved' | 'rejected'): Promise<void> {
  if (!id) {
    console.log(chalk.red(`usage: overseer supervise ${status} <id>`));
    process.exit(2);
  }
  const a = approvals.decide(id, status);
  if (!a) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  console.log(chalk.green(`\n✓ ${a.id} → ${a.status}`));
  if (a.status === 'approved') {
    const res = await fulfill(a);
    if (res.handled) {
      if (res.ok) {
        console.log(chalk.green(`  ↳ 已执行 ${res.action}`) + chalk.gray(` (snapshot ${res.snapshotId ?? '-'})`));
      } else {
        console.log(chalk.red(`  ↳ 执行失败: ${res.error}`));
      }
    }
  }
  console.log();
}

function severityColor(s: string): (t: string) => string {
  if (s === 'critical') return chalk.red;
  if (s === 'high') return chalk.magenta;
  if (s === 'medium') return chalk.yellow;
  return chalk.gray;
}
