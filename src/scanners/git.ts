import path from 'node:path';
import type { Scanner, ScannerContext, IntentionSeed } from './base.js';
import { nowIso } from './base.js';
import { ProjectGit } from '../vcs/git.js';

/**
 * Git 扫描器：发现长期未提交、未推送、未追踪、落后远端的状况。
 * cheap（只调 git status / log），不修改仓库。
 */
export class GitScanner implements Scanner {
  readonly id = 'git';
  readonly description = '检测未提交/未推送/未追踪/远端落后';
  readonly cost = 'cheap' as const;

  async scan(ctx: ScannerContext): Promise<IntentionSeed[]> {
    if (!ctx.project.isGitRepo) return [];
    const out: IntentionSeed[] = [];
    const git = new ProjectGit(ctx.project.rootAbs);
    let status;
    try {
      status = await git.status();
    } catch {
      return [];
    }
    if (!status.isRepo) return [];
    const p = ctx.project.id;
    const t = nowIso();

    if (status.dirty) {
      const total = status.modified + status.untracked + status.staged;
      if (total >= 5) {
        out.push({
          key: `git:dirty:${p}`,
          project: p,
          source: 'git',
          category: 'hygiene',
          severity: total >= 20 ? 'high' : 'medium',
          title: `${p} 工作树有 ${total} 个未提交改动`,
          detail: `modified=${status.modified} untracked=${status.untracked} staged=${status.staged}。建议尽快提交、stash 或拆分提交，避免与其他工作混杂。`,
          hint: '查看 `git status` + `git diff`，决定提交或拆分',
          detectedAt: t,
        });
      }
    }

    if (status.hasRemote && status.ahead && status.ahead >= 10) {
      out.push({
        key: `git:ahead:${p}`,
        project: p,
        source: 'git',
        category: 'hygiene',
        severity: status.ahead >= 30 ? 'medium' : 'low',
        title: `${p} 领先远端 ${status.ahead} 个提交未推送`,
        detail: '长期不推送容易丢失工作 / 与协作者产生大量冲突。',
        hint: '确认后 `git push`；或拆小提交',
        detectedAt: t,
      });
    }

    if (status.hasRemote && status.behind && status.behind >= 10) {
      out.push({
        key: `git:behind:${p}`,
        project: p,
        source: 'git',
        category: 'tech-debt',
        severity: status.behind >= 50 ? 'high' : 'medium',
        title: `${p} 落后远端 ${status.behind} 个提交`,
        detail: '长期不拉容易在合并时产生大量冲突；CI 也可能跑的是旧代码。',
        hint: '`git fetch` 后看 `git log HEAD..@{u}` 决定 rebase 或 merge',
        detectedAt: t,
      });
    }

    try {
      const log = await git.raw(['log', '--pretty=format:%H|%ci', '-30']);
      const lines = log.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const lastCommitIso = lines[0].split('|')[1];
        const days = (Date.now() - Date.parse(lastCommitIso)) / 86_400_000;
        if (days >= 14) {
          out.push({
            key: `git:stale:${p}`,
            project: p,
            source: 'git',
            category: 'hygiene',
            severity: days >= 60 ? 'medium' : 'low',
            title: `${p} 已 ${Math.floor(days)} 天无提交`,
            detail: `最近提交：${lastCommitIso}。需要确认项目状态：完成？搁置？还是缺维护？`,
            hint: '在 vault 里补一条 retro 笔记标记当前状态',
            detectedAt: t,
          });
        }
      }
    } catch {
      /* ignore log failure */
    }

    void path;
    return out.slice(0, ctx.limitPerScanner);
  }
}
