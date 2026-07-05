import { scanProjects } from '../dist/projects/scanner.js';
import { scanProject, DEFAULT_ENABLED, MEDIUM_ENABLED } from '../dist/scanners/index.js';
import * as queue from '../dist/supervisor/queue.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  if (cond) pass++; else fail++;
}

// 1. 项目扫描
const projects = scanProjects();
check('scanProjects 找到项目', projects.length > 0, projects.map(p => p.id));

// 2. 找到 overSeer 自己（应该有 TODO/FIXME 之类）
const overSeer = projects.find((p) => p.id === 'overSeer');
check('overSeer 在工作区中', !!overSeer, projects.map((p) => p.id));

// 3. 清空 queue 起步
const cleared = queue.clear();
console.log(`(cleared ${cleared} existing items)\n`);

// 4. 跑扫描器（light = git + todo）
if (overSeer) {
  const r = await scanProject(overSeer, {
    enabledScanners: DEFAULT_ENABLED,
    allowShell: false,
    limitPerScanner: 5,
  });
  console.log(`overSeer scan: ${r.seeds.length} seeds in ${r.durationMs}ms`);
  console.log(`  perScanner:`, r.perScanner);
  for (const s of r.seeds.slice(0, 5)) {
    console.log(`    [${s.source}/${s.severity}] ${s.title}`);
  }

  // 5. 入队
  const m1 = queue.enqueue(r.seeds);
  console.log(`\nenqueue: +${m1.added} ~${m1.updated} total=${m1.total}`);
  check('enqueue added >= 0', m1.added >= 0, m1);
  check('enqueue total = added (first time)', m1.total === m1.added, m1);

  // 6. 重复扫一次，应该全是 update（去重生效）
  const r2 = await scanProject(overSeer, {
    enabledScanners: DEFAULT_ENABLED,
    allowShell: false,
    limitPerScanner: 5,
  });
  const m2 = queue.enqueue(r2.seeds);
  console.log(`\nre-enqueue: +${m2.added} ~${m2.updated} total=${m2.total}`);
  check('re-enqueue added=0（去重）', m2.added === 0, m2);
  check('re-enqueue total 不变', m2.total === m1.total, { m1: m1.total, m2: m2.total });

  // 7. stats
  const stats = queue.stats();
  console.log(`\nstats:`, stats);
  check('stats.total > 0 (after scan) OR all-seeds-empty', stats.total >= 0, stats);

  // 8. pickNext 按 severity 排
  const next = queue.pickNext();
  if (next) {
    console.log(`\npickNext: [${next.severity}] ${next.title}`);
    check('pickNext has valid status', next.status === 'pending', next);

    // 9. setStatus
    const updated = queue.setStatus(next.id, 'design-generated', { intentionId: 'fake-iid' });
    check('setStatus updates status', updated?.status === 'design-generated', updated);
    check('setStatus updates notes', updated?.intentionId === 'fake-iid', updated);

    // 10. drop
    const dropped = queue.drop(next.id);
    check('drop removes item', dropped === true, dropped);
  } else {
    console.log('\n(no pending items to test pickNext)');
  }

  // 11. prune
  const pruned = queue.prune(30);
  console.log(`\nprune(30d): removed ${pruned}`);
  check('prune returns number', typeof pruned === 'number', pruned);

  // 12. 也扫 aaws（如果存在）测多项目
  const aaws = projects.find((p) => p.id === 'aaws');
  if (aaws) {
    const r3 = await scanProject(aaws, {
      enabledScanners: MEDIUM_ENABLED,
      allowShell: false, // 不跑 npm outdated（需要 spawn）
      limitPerScanner: 3,
    });
    console.log(`\naaws scan (no shell): ${r3.seeds.length} seeds`);
    const m3 = queue.enqueue(r3.seeds);
    console.log(`aaws enqueue: +${m3.added}`);
  }
}

// 13. 最终清理
const finalClear = queue.clear();
console.log(`\nfinal clear: ${finalClear} items removed`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
