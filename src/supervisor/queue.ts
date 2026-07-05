import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import type { IntentionSeed } from '../scanners/base.js';

export type QueueItemStatus = 'pending' | 'plan-generated' | 'design-generated' | 'executing' | 'done' | 'abandoned';

export interface QueueItem {
  /** 持久 id（与 seed.key 解耦，便于多次重扫入队） */
  id: string;
  /** 去重键：project + source + key */
  dedupe: string;
  project: string;
  source: IntentionSeed['source'];
  category: IntentionSeed['category'];
  severity: IntentionSeed['severity'];
  title: string;
  detail: string;
  hint?: string;
  files?: string[];
  status: QueueItemStatus;
  firstSeen: string;
  lastSeen: string;
  /** 升级到 LLM 意向后写入；为空表示尚未升华 */
  intentionId?: string;
  notes?: string;
}

const QUEUE_FILE = path.join(PATHS.DATA_DIR, 'queue.json');

function ensure(): void {
  if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  if (!fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, '[]', 'utf8');
}

function read(): QueueItem[] {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) as QueueItem[];
  } catch {
    return [];
  }
}

function write(items: QueueItem[]): void {
  ensure();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function severityRank(s: QueueItem['severity']): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}

function dedupeKey(seed: IntentionSeed): string {
  return `${seed.project}::${seed.source}::${seed.key}`;
}

export function enqueue(seeds: IntentionSeed[]): { added: number; updated: number; total: number } {
  if (seeds.length === 0) return { added: 0, updated: 0, total: read().length };
  const items = read();
  const byDedupe = new Map(items.map((i) => [i.dedupe, i]));
  let added = 0;
  let updated = 0;
  const now = new Date().toISOString();

  for (const seed of seeds) {
    const key = dedupeKey(seed);
    const existing = byDedupe.get(key);
    if (existing) {
      const prevSeverity = existing.severity;
      existing.lastSeen = now;
      existing.title = seed.title;
      existing.detail = seed.detail;
      existing.severity = seed.severity;
      existing.files = seed.files;
      if (prevSeverity !== seed.severity) updated++;
      byDedupe.set(key, existing);
    } else {
      const item: QueueItem = {
        id: 'q-' + Math.random().toString(36).slice(2, 9),
        dedupe: key,
        project: seed.project,
        source: seed.source,
        category: seed.category,
        severity: seed.severity,
        title: seed.title,
        detail: seed.detail,
        hint: seed.hint,
        files: seed.files,
        status: 'pending',
        firstSeen: now,
        lastSeen: now,
      };
      items.push(item);
      byDedupe.set(key, item);
      added++;
    }
  }
  write(items);
  return { added, updated, total: items.length };
}

export function list(opts: { project?: string; status?: QueueItemStatus; limit?: number } = {}): QueueItem[] {
  let items = read();
  if (opts.project) items = items.filter((i) => i.project === opts.project);
  if (opts.status) items = items.filter((i) => i.status === opts.status);
  items.sort((a, b) => {
    const sr = severityRank(b.severity) - severityRank(a.severity);
    if (sr !== 0) return sr;
    return a.lastSeen.localeCompare(b.lastSeen);
  });
  return items.slice(0, opts.limit ?? 100);
}

export function listPending(project?: string): QueueItem[] {
  return list({ project, status: 'pending' });
}

export function getById(id: string): QueueItem | null {
  return read().find((i) => i.id === id) ?? null;
}

export function setStatus(id: string, status: QueueItemStatus, extra?: Partial<QueueItem>): QueueItem | null {
  const items = read();
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return null;
  items[idx] = { ...items[idx], ...extra, status };
  write(items);
  return items[idx];
}

export function drop(id: string): boolean {
  const items = read();
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return false;
  write(next);
  return true;
}

export function clear(project?: string): number {
  const items = read();
  const next = project ? items.filter((i) => i.project !== project) : [];
  const removed = items.length - next.length;
  write(next);
  return removed;
}

export function prune(maxAgeDays = 30): number {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const items = read();
  const next = items.filter((i) => {
    if (i.status === 'pending') return true;
    return Date.parse(i.lastSeen) >= cutoff;
  });
  const removed = items.length - next.length;
  if (removed > 0) write(next);
  return removed;
}

export function stats(): {
  total: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
  byProject: Record<string, number>;
  bySource: Record<string, number>;
} {
  const items = read();
  const byStatus: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const i of items) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
    byProject[i.project] = (byProject[i.project] ?? 0) + 1;
    bySource[i.source] = (bySource[i.source] ?? 0) + 1;
  }
  return { total: items.length, byStatus, bySeverity, byProject, bySource };
}

export function pickNext(project?: string): QueueItem | null {
  const log = getLogger('queue');
  const pending = listPending(project);
  if (pending.length === 0) return null;
  const top = pending[0];
  log.info({ id: top.id, project: top.project, severity: top.severity, title: top.title.slice(0, 60) }, 'picked next');
  return top;
}
