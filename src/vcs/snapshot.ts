import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import { ProjectGit } from './git.js';

export interface Snapshot {
  id: string;
  projectId: string;
  projectRoot: string;
  branch?: string;
  headSha?: string;
  hadDirty: boolean;
  stashed: boolean;
  tag?: string;
  createdAt: string;
  reason: string;
}

const SNAP_DIR = path.join(PATHS.DATA_DIR, 'snapshots');
const TAG_PREFIX = 'overseer/snap';

function ensureSnapDir(): void {
  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });
}

function snapFile(id: string): string {
  return path.join(SNAP_DIR, `${id}.json`);
}

export function listSnapshots(): Snapshot[] {
  ensureSnapDir();
  const out: Snapshot[] = [];
  for (const f of fs.readdirSync(SNAP_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(SNAP_DIR, f), 'utf8')) as Snapshot);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readSnapshot(id: string): Snapshot | null {
  const f = snapFile(id);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export function deleteSnapshot(id: string): void {
  const f = snapFile(id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export class Snapshotter {
  private log = getLogger('snapshot');
  constructor(public readonly git: ProjectGit) {}

  async take(reason: string, idHint?: string, opts: { noStash?: boolean } = {}): Promise<Snapshot> {
    const id = idHint ?? newSnapId();
    const status = await this.git.status();
    const headSha = await this.git.headSha();

    let stashed = false;
    if (status.isRepo && status.dirty && !opts.noStash) {
      stashed = await this.git.stashPush(`overseer-snap-${id}`);
      this.log.info({ id, stashed }, 'dirty state stashed before action');
    }

    let tag: string | undefined;
    if (status.isRepo && headSha) {
      tag = `${TAG_PREFIX}/${id}`;
      try {
        await this.git.createLightweightTag(tag, headSha);
      } catch (e) {
        this.log.warn({ err: String(e), tag }, 'tag creation failed (continue anyway)');
        tag = undefined;
      }
    }

    const snap: Snapshot = {
      id,
      projectId: path.basename(this.git.rootAbs),
      projectRoot: this.git.rootAbs,
      branch: status.currentBranch,
      headSha,
      hadDirty: status.dirty,
      stashed,
      tag,
      createdAt: new Date().toISOString(),
      reason,
    };

    ensureSnapDir();
    fs.writeFileSync(snapFile(id), JSON.stringify(snap, null, 2), 'utf8');
    this.log.info(
      { id, branch: snap.branch, headSha: headSha?.slice(0, 8), tag, stashed },
      'snapshot taken'
    );
    return snap;
  }
}

export function newSnapId(): string {
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}
