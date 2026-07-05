import fs from 'node:fs';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import { listSnapshots, deleteSnapshot } from './snapshot.js';

export interface RetentionResult {
  ledgerTrimmed: number;
  metricsTrimmed: number;
  snapshotsRemoved: number;
  tagsRemoved: number;
}

/**
 * 运行时数据滚动清理。
 *
 * - token-ledger / provider-metrics：保留最近 retainDays 天（默认 90）
 * - snapshots：保留最近 maxSnapshots 个（默认 50），超出的删除 manifest 与对应 git tag
 */
export class DataRetention {
  private log = getLogger('retention');

  constructor(
    private readonly retainDays = 90,
    private readonly maxSnapshots = 50
  ) {}

  async run(): Promise<RetentionResult> {
    const result: RetentionResult = {
      ledgerTrimmed: 0,
      metricsTrimmed: 0,
      snapshotsRemoved: 0,
      tagsRemoved: 0,
    };

    result.ledgerTrimmed = this.trimJsonl(PATHS.TOKEN_LEDGER, this.retainDays);
    result.metricsTrimmed = this.trimJsonl(PATHS.METRICS_LEDGER, this.retainDays);

    const snapResult = await this.trimSnapshots();
    result.snapshotsRemoved = snapResult.snapshotsRemoved;
    result.tagsRemoved = snapResult.tagsRemoved;

    this.log.info(result, 'data retention run');
    return result;
  }

  private trimJsonl(file: string, days: number): number {
    if (!fs.existsSync(file)) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n');
    let kept = 0;
    let removed = 0;
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as { ts?: string };
        if (obj.ts && obj.ts < cutoff) {
          removed++;
        } else {
          out.push(t);
          kept++;
        }
      } catch {
        out.push(t);
        kept++;
      }
    }
    if (removed > 0) {
      fs.writeFileSync(file, out.join('\n') + (out.length > 0 ? '\n' : ''), 'utf8');
    }
    return removed;
  }

  private async trimSnapshots(): Promise<{ snapshotsRemoved: number; tagsRemoved: number }> {
    const snaps = listSnapshots();
    if (snaps.length <= this.maxSnapshots) return { snapshotsRemoved: 0, tagsRemoved: 0 };

    // 按时间从旧到新排序，删除最老的
    const sorted = [...snaps].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const toRemove = sorted.slice(0, sorted.length - this.maxSnapshots);

    let tagsRemoved = 0;
    for (const snap of toRemove) {
      if (snap.tag) {
        try {
          const git = this.gitFor(snap.projectRoot);
          if (git) {
            await git.raw(['tag', '-d', snap.tag]);
            tagsRemoved++;
          }
        } catch (e) {
          this.log.warn({ snap: snap.id, err: String(e) }, 'failed to delete snapshot tag');
        }
      }
      deleteSnapshot(snap.id);
    }

    return { snapshotsRemoved: toRemove.length, tagsRemoved };
  }

  private gitFor(projectRoot: string): any {
    try {
      // 懒加载避免循环依赖
      const { ProjectGit } = require('./git.js');
      return new ProjectGit(projectRoot);
    } catch {
      return null;
    }
  }
}
