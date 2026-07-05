import { IpcClient } from '../dist/daemon/ipc.js';

const c = new IpcClient('overseer');

async function test() {
  console.log('ping:', await c.request('ping'));

  // cycle.run light (no shell, read-only scanners only)
  const cycle = await c.request('cycle.run', { aggressiveness: 'light', onlyProjects: ['overSeer'] });
  console.log('cycle.run:', {
    mode: cycle.mode,
    projects: cycle.projects.length,
    added: cycle.added,
    queueAfter: cycle.queueAfter,
  });

  // queue.list
  const q = await c.request('queue.list', { limit: 5 });
  console.log('queue.list:', q.length);

  // approvals.list
  const appr = await c.request('approvals.list', { pendingOnly: true });
  console.log('approvals.list:', appr.length);

  // health.check
  const health = await c.request('health.check');
  console.log('health.check providers:', health.providers.map((p) => `${p.id}=${p.reachable}`));

  // kb.search
  const hits = await c.request('kb.search', { q: 'test', limit: 3 });
  console.log('kb.search:', hits.length);

  console.log('all ops ok');
}

test().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
