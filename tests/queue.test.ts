import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as queue from '../src/supervisor/queue.js';
import { PATHS } from '../src/util/paths.js';

const QUEUE_FILE = path.join(PATHS.DATA_DIR, 'queue.json');
let backup: Buffer | null = null;

function seed(project: string, key: string, severity: any) {
  return {
    key,
    project,
    source: 'todo' as const,
    category: 'tech-debt' as const,
    severity,
    title: `${project} ${key}`,
    detail: 'detail',
    detectedAt: new Date().toISOString(),
  };
}

describe('queue', () => {
  beforeEach(() => {
    if (fs.existsSync(QUEUE_FILE)) {
      backup = fs.readFileSync(QUEUE_FILE);
    } else {
      backup = null;
    }
    fs.writeFileSync(QUEUE_FILE, '[]', 'utf8');
  });

  afterEach(() => {
    if (backup === null) {
      if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE);
    } else {
      fs.writeFileSync(QUEUE_FILE, backup);
    }
  });

  it('enqueue 新增条目', () => {
    const r = queue.enqueue([seed('p1', 'k1', 'high')]);
    expect(r.added).toBe(1);
    expect(r.total).toBe(1);
  });

  it('enqueue 去重并更新', () => {
    queue.enqueue([seed('p1', 'k1', 'medium')]);
    const r = queue.enqueue([seed('p1', 'k1', 'high')]);
    expect(r.added).toBe(0);
    expect(r.updated).toBe(1);
    const items = queue.list();
    expect(items[0].severity).toBe('high');
  });

  it('list 按 severity 排序', () => {
    queue.enqueue([
      seed('p1', 'low1', 'low'),
      seed('p1', 'high1', 'high'),
      seed('p1', 'medium1', 'medium'),
    ]);
    const items = queue.list();
    expect(items[0].severity).toBe('high');
    expect(items[1].severity).toBe('medium');
    expect(items[2].severity).toBe('low');
  });

  it('setStatus 更新状态', () => {
    queue.enqueue([seed('p1', 'k1', 'high')]);
    const item = queue.list()[0];
    const updated = queue.setStatus(item.id, 'design-generated', { notes: 'done design' });
    expect(updated?.status).toBe('design-generated');
    expect(updated?.notes).toBe('done design');
  });

  it('drop 删除条目', () => {
    queue.enqueue([seed('p1', 'k1', 'high')]);
    const item = queue.list()[0];
    expect(queue.drop(item.id)).toBe(true);
    expect(queue.list().length).toBe(0);
  });

  it('clear 清空', () => {
    queue.enqueue([seed('p1', 'k1', 'high'), seed('p2', 'k2', 'low')]);
    expect(queue.clear()).toBe(2);
    expect(queue.stats().total).toBe(0);
  });

  it('prune 清理非 pending 老条目', () => {
    queue.enqueue([seed('p1', 'k1', 'high')]);
    const item = queue.list()[0];
    queue.setStatus(item.id, 'done');
    // 手动把 lastSeen 改到 40 天前
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    raw[0].lastSeen = new Date(Date.now() - 40 * 86_400_000).toISOString();
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(raw));
    expect(queue.prune(30)).toBe(1);
    expect(queue.stats().total).toBe(0);
  });

  it('pickNext 返回最高 severity pending', () => {
    queue.enqueue([
      seed('p1', 'low1', 'low'),
      seed('p1', 'high1', 'high'),
    ]);
    const next = queue.pickNext();
    expect(next?.severity).toBe('high');
  });
});
