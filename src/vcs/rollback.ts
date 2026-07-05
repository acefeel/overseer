import { getLogger } from '../util/logger.js';
import { ProjectGit } from './git.js';
import { readSnapshot, deleteSnapshot, type Snapshot } from './snapshot.js';

export interface RollbackResult {
  ok: boolean;
  snap: Snapshot;
  resetCommits: boolean;
  restoredStash: boolean;
  error?: string;
}

export class Rollback {
  private log = getLogger('rollback');
  constructor(public readonly git: ProjectGit) {}

  async to(snapId: string): Promise<RollbackResult> {
    const snap = readSnapshot(snapId);
    if (!snap) {
      return this.fail(snapId as unknown as Snapshot, `snapshot ${snapId} not found`);
    }
    if (!snap.headSha) {
      this.log.warn({ id: snapId }, 'snapshot has no headSha — only manifest removed');
      deleteSnapshot(snapId);
      return {
        ok: true,
        snap,
        resetCommits: false,
        restoredStash: false,
        error: 'no git ref to rollback to',
      };
    }

    const currentStatus = await this.git.status();
    if (!currentStatus.isRepo) {
      return this.fail(snap, 'project no longer a git repo');
    }

    let resetCommits = false;
    if (snap.tag) {
      try {
        const currentHead = await this.git.headSha();
        if (currentHead && currentHead !== snap.headSha) {
          await this.git.resetHard(snap.tag);
          resetCommits = true;
          this.log.warn({ snapId, to: snap.headSha.slice(0, 8) }, 'reset --hard to snapshot');
        }
      } catch (e) {
        return this.fail(snap, `reset --hard failed: ${(e as Error).message}`);
      }
    }

    let restoredStash = false;
    if (snap.stashed) {
      try {
        await this.git.raw(['stash', 'pop']);
        restoredStash = true;
        this.log.info({ snapId }, 'stashed dirty state restored');
      } catch (e) {
        this.log.warn({ err: String(e), snapId }, 'stash pop failed; user can `git stash list`');
      }
    }

    deleteSnapshot(snapId);
    return { ok: true, snap, resetCommits, restoredStash };
  }

  private fail(snap: Snapshot, error: string): RollbackResult {
    this.log.error({ id: snap.id, err: error }, 'rollback failed');
    return { ok: false, snap, resetCommits: false, restoredStash: false, error };
  }
}
