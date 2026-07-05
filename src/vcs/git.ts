import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getLogger } from '../util/logger.js';

export interface RepoStatus {
  isRepo: boolean;
  currentBranch?: string;
  hasRemote?: boolean;
  dirty: boolean;
  untracked: number;
  modified: number;
  staged: number;
  ahead?: number;
  behind?: number;
}

export class ProjectGit {
  readonly git: SimpleGit;
  private log;

  constructor(public readonly rootAbs: string) {
    this.git = simpleGit({ baseDir: rootAbs });
    this.log = getLogger(`git:${path.basename(rootAbs)}`);
  }

  async status(): Promise<RepoStatus> {
    try {
      const isRepo = (await this.git.checkIsRepo()) as boolean;
      if (!isRepo) {
        return {
          isRepo: false,
          dirty: false,
          untracked: 0,
          modified: 0,
          staged: 0,
        };
      }
      const s = await this.git.status();
      let hasRemote = false;
      try {
        const remotes = await this.git.getRemotes(true);
        hasRemote = remotes.length > 0;
      } catch {
        /* ignore */
      }
      return {
        isRepo: true,
        currentBranch: s.current ?? undefined,
        hasRemote,
        dirty: s.files.length > 0,
        untracked: s.not_added.length,
        modified: s.modified.length,
        staged: s.staged.length,
        ahead: s.ahead || 0,
        behind: s.behind || 0,
      };
    } catch (e) {
      this.log.debug({ err: String(e) }, 'status failed');
      return { isRepo: false, dirty: false, untracked: 0, modified: 0, staged: 0 };
    }
  }

  async ensureIdentity(): Promise<void> {
    try {
      const name = (await this.git.raw(['config', 'user.name']))?.trim();
      const email = (await this.git.raw(['config', 'user.email']))?.trim();
      if (!name) await this.git.addConfig('user.name', 'overSeer', false, 'local');
      if (!email) await this.git.addConfig('user.email', 'overseer@local', false, 'local');
    } catch (e) {
      this.log.debug({ err: String(e) }, 'ensureIdentity skipped');
    }
  }

  async listLocalBranches(): Promise<string[]> {
    try {
      const b = await this.git.branchLocal();
      return b.all;
    } catch {
      return [];
    }
  }

  async createBranch(name: string, fromRef?: string): Promise<void> {
    await this.git.checkoutBranch(name, fromRef ?? 'HEAD');
  }

  async checkout(ref: string): Promise<void> {
    await this.git.checkout(ref);
  }

  async addAll(): Promise<void> {
    await this.git.add(['-A']);
  }

  async commit(message: string): Promise<string> {
    await this.ensureIdentity();
    const r = await this.git.commit(message, undefined, { '--no-verify': null });
    return r.commit || '';
  }

  async createLightweightTag(name: string, ref = 'HEAD'): Promise<void> {
    await this.git.addTag(name);
    void ref;
  }

  async listTags(): Promise<string[]> {
    try {
      const t = await this.git.tags();
      return t.all;
    } catch {
      return [];
    }
  }

  async revParse(ref: string): Promise<string | undefined> {
    try {
      const r = await this.git.revparse([ref]);
      return r.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async headSha(): Promise<string | undefined> {
    return this.revParse('HEAD');
  }

  async isClean(): Promise<boolean> {
    const s = await this.git.status();
    return s.files.length === 0;
  }

  async stashPush(message: string): Promise<boolean> {
    try {
      await this.git.stash(['push', '-u', '-m', message]);
      return true;
    } catch {
      return false;
    }
  }

  async resetHard(toRef: string): Promise<void> {
    await this.git.raw(['reset', '--hard', toRef]);
  }

  async raw(args: string[]): Promise<string> {
    return this.git.raw(args);
  }
}
