import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import type { SupervisionMode } from '../daemon/mode.js';

export interface PendingApproval {
  id: string;
  ts: string;
  project: string;
  action: string;
  description: string;
  /** 写在动作真正执行前用于回看的上下文（diff、commit message 等） */
  context: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  decisionTs?: string;
  decisionBy?: string;
}

const APPROVAL_FILE = path.join(PATHS.DATA_DIR, 'approvals.json');

function ensureFile(): void {
  if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  if (!fs.existsSync(APPROVAL_FILE)) fs.writeFileSync(APPROVAL_FILE, '[]', 'utf8');
}

export function listPending(): PendingApproval[] {
  ensureFile();
  try {
    const arr = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')) as PendingApproval[];
    return arr.filter((a) => a.status === 'pending').sort((a, b) => b.ts.localeCompare(a.ts));
  } catch {
    return [];
  }
}

export function listAll(): PendingApproval[] {
  ensureFile();
  try {
    const arr = JSON.parse(fs.readFileSync(APPROVAL_FILE, 'utf8')) as PendingApproval[];
    return arr.sort((a, b) => b.ts.localeCompare(a.ts));
  } catch {
    return [];
  }
}

export function create(p: Omit<PendingApproval, 'id' | 'ts' | 'status'>): PendingApproval {
  ensureFile();
  const all = listAll();
  const item: PendingApproval = {
    ...p,
    id: newApprovalId(),
    ts: new Date().toISOString(),
    status: 'pending',
  };
  all.push(item);
  fs.writeFileSync(APPROVAL_FILE, JSON.stringify(all, null, 2), 'utf8');
  return item;
}

export function decide(id: string, status: 'approved' | 'rejected', by = 'cli'): PendingApproval | null {
  ensureFile();
  const all = listAll();
  const idx = all.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  all[idx].status = status;
  all[idx].decisionTs = new Date().toISOString();
  all[idx].decisionBy = by;
  fs.writeFileSync(APPROVAL_FILE, JSON.stringify(all, null, 2), 'utf8');
  return all[idx];
}

/**
 * 将超过 maxAgeDays 仍未处理的 pending approval 标记为 expired。
 */
export function expirePending(maxAgeDays = 30): number {
  ensureFile();
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
  const all = listAll();
  let expired = 0;
  for (const a of all) {
    if (a.status === 'pending' && a.ts < cutoff) {
      a.status = 'expired';
      a.decisionTs = new Date().toISOString();
      a.decisionBy = 'retention';
      expired++;
    }
  }
  if (expired > 0) {
    fs.writeFileSync(APPROVAL_FILE, JSON.stringify(all, null, 2), 'utf8');
  }
  return expired;
}

export function waitForDecision(
  id: string,
  timeoutMs = 5 * 60_000
): Promise<PendingApproval | null> {
  const log = getLogger('approvals');
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const all = listAll();
      const item = all.find((a) => a.id === id);
      if (item && item.status !== 'pending') return resolve(item);
      if (Date.now() - start > timeoutMs) {
        log.warn({ id, timeoutMs }, 'approval wait timed out');
        return resolve(null);
      }
      setTimeout(tick, 1500);
    };
    tick();
  });
}

export function isBlockedByMode(_action: string, mode: SupervisionMode): boolean {
  if (mode === 'normal') return false;
  return true;
}

function newApprovalId(): string {
  return 'appr-' + Math.random().toString(36).slice(2, 10);
}
