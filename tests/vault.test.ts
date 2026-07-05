import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Vault } from '../src/kb/vault.js';
import { VaultWriter } from '../src/kb/writer.js';
import { VaultRetriever } from '../src/kb/retriever.js';
import type { NoteType } from '../src/kb/schema.js';

function tmpVault(): { root: string; vault: Vault; writer: VaultWriter; retriever: VaultRetriever } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-vault-'));
  const vault = new Vault(root);
  vault.ensure();
  const writer = new VaultWriter(vault);
  const retriever = new VaultRetriever(vault);
  return { root, vault, writer, retriever };
}

describe('Vault integration', () => {
  let ctx: ReturnType<typeof tmpVault>;

  beforeEach(() => {
    ctx = tmpVault();
  });

  afterEach(() => {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  it('write + search', () => {
    ctx.writer.write({
      type: 'knowledge',
      project: 'p1',
      title: '架构决策',
      tags: ['adr', 'architecture'],
      body: '我们选用 TypeScript ESM 作为项目基础。',
    });

    const hits = ctx.retriever.search({ q: 'TypeScript ESM', limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].note.body).toContain('TypeScript');
  });

  it('按 type 过滤', () => {
    ctx.writer.write({ type: 'knowledge', project: 'p1', title: 'A', tags: [], body: 'body' });
    ctx.writer.write({ type: 'plan', project: 'p1', title: 'B', tags: [], body: 'plan body' });

    const plans = ctx.retriever.search({ type: 'plan' as NoteType, q: 'plan' });
    expect(plans.every((h) => (h.note.frontmatter as any).type === 'plan')).toBe(true);
  });

  it('recent 按时间排序', () => {
    ctx.writer.write({ type: 'knowledge', project: 'p1', title: 'Old', tags: [], body: 'old' });
    ctx.writer.write({ type: 'knowledge', project: 'p1', title: 'New', tags: [], body: 'new' });

    const recent = ctx.retriever.recent(10);
    expect(recent[0].slug).toBe('new');
  });

  it('show 读取单条笔记', () => {
    const res = ctx.writer.write({ type: 'knowledge', project: 'p1', title: 'Show Me', tags: [], body: 'content' });
    const note = ctx.retriever.show(res.note.relativePath);
    expect(note?.body).toContain('content');
  });
});
