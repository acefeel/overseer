import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { simpleGit } from 'simple-git';
import { ProjectGit } from '../dist/vcs/git.js';
import { Snapshotter, listSnapshots } from '../dist/vcs/snapshot.js';
import { Rollback } from '../dist/vcs/rollback.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-m3-'));
console.log('temp repo:', tmp);

// 1. 初始化一个临时 git 仓库 + 一个初始提交
const init = simpleGit(tmp);
await init.init();
await init.addConfig('user.name', 'smoke', 'local');
await init.addConfig('user.email', 'smoke@local', 'local');
fs.writeFileSync(path.join(tmp, 'README.md'), '# init\n');
await init.add('README.md');
await init.commit('init');

const git = new ProjectGit(tmp);
const snap = new Snapshotter(git);
const rb = new Rollback(git);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  if (cond) pass++; else fail++;
}

// 2. 干净状态下拍快照
const s1 = await snap.take('clean baseline');
check('snapshot on clean repo has headSha', !!s1.headSha, s1);
check('snapshot on clean repo: stashed=false', s1.stashed === false, s1);
check('snapshot on clean repo: hadDirty=false', s1.hadDirty === false, s1);

// 3. 模拟 overSeer 改动并 commit
fs.writeFileSync(path.join(tmp, 'CHANGE.md'), '# change by overseer\n');
await git.addAll();
const commitSha = await git.commit('[overseer] test change');
check('commit succeeded', !!commitSha, commitSha);
const after1 = await git.headSha();
check('HEAD moved after commit', after1 !== s1.headSha, { before: s1.headSha, after: after1 });

// 4. 回滚到快照
const r1 = await rb.to(s1.id);
check('rollback ok', r1.ok, r1);
check('rollback reset commits', r1.resetCommits === true, r1);
const afterRollback = await git.headSha();
check('HEAD restored to snap', afterRollback === s1.headSha, { snap: s1.headSha, now: afterRollback });

// 5. 测试脏状态（uncommitted）下拍快照
fs.writeFileSync(path.join(tmp, 'wip.md'), 'wip content');
const s2 = await snap.take('with WIP');
check('snapshot on dirty repo: stashed=true', s2.stashed === true, s2);
check('snapshot on dirty repo: hadDirty=true', s2.hadDirty === true, s2);
const cleanAfterStash = await git.isClean();
check('repo is clean after stash', cleanAfterStash, {});

// 6. 提交一些 overSeer 改动
fs.writeFileSync(path.join(tmp, 'CHANGE2.md'), 'change2\n');
await git.addAll();
await git.commit('[overseer] change 2');

// 7. 回滚到 s2（应该恢复 stash）
const r2 = await rb.to(s2.id);
check('rollback with stash ok', r2.ok, r2);
check('rollback restored stash', r2.restoredStash === true, r2);
const wipExists = fs.existsSync(path.join(tmp, 'wip.md'));
check('wip.md restored after stash pop', wipExists, {});

// 8. snapshots 文件清理
const remaining = listSnapshots().filter((s) => s.projectId === path.basename(tmp));
check('snapshots cleaned after rollback', remaining.length === 0, remaining);

// 清理临时目录
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\ncleaned up temp repo');
} catch (e) {
  console.log('\ncleanup skipped:', e.message);
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
