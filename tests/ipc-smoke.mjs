import { IpcClient } from '../dist/daemon/ipc.js';

const c = new IpcClient('overseer');
const status = await c.request('status').catch((e) => ({ error: e.message }));
console.log('STATUS vaultNotes:', status.vaultNotes);

const r = await c.request('kb.search', { q: 'budget' });
console.log('KB SEARCH budget →', r.slice(0, 2).map((x) => ({
  slug: x.note.slug,
  score: x.score,
  type: x.note.frontmatter.type,
})));

const recent = await c.request('kb.recent', { limit: 3 });
console.log('KB RECENT →', recent.map((n) => n.slug));

process.exit(0);
