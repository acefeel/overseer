import fs from 'node:fs';
import path from 'node:path';
import type { Scanner, ScannerContext, IntentionSeed } from './base.js';
import { nowIso } from './base.js';

const DEFAULT_IGNORE = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.vscode',
  '.idea',
  'vendor',
  'coverage',
  '.next',
  '.cache',
  'bin',
  'obj',
  'target',
  '__pycache__',
  '.overseer.json',
]);

const PATTERN = /\b(TODO|FIXME|XXX|HACK|BUG|NOTE)\b[:\s]?([^\n\r]*)/g;

interface Hit {
  file: string;
  line: number;
  tag: string;
  text: string;
}

/**
 * 扫描源码里的 TODO/FIXME/XXX/HACK/BUG/NOTE 注释。
 * cheap（纯 fs.walk），但限制最大文件数避免大仓库拖慢。
 */
export class TodoScanner implements Scanner {
  readonly id = 'todo';
  readonly description = '扫描 TODO/FIXME/XXX/HACK/BUG/NOTE 注释';
  readonly cost = 'cheap' as const;

  async scan(ctx: ScannerContext): Promise<IntentionSeed[]> {
    const hits = this.collect(ctx.project.rootAbs, 400);
    if (hits.length === 0) return [];

    const byTag = new Map<string, Hit[]>();
    for (const h of hits) {
      const arr = byTag.get(h.tag) ?? [];
      arr.push(h);
      byTag.set(h.tag, arr);
    }

    const out: IntentionSeed[] = [];
    const p = ctx.project.id;
    const t = nowIso();

    const severityByTag: Record<string, IntentionSeed['severity']> = {
      FIXME: 'high',
      BUG: 'high',
      HACK: 'medium',
      XXX: 'medium',
      TODO: 'low',
      NOTE: 'low',
    };

    for (const [tag, arr] of byTag) {
      const sev = severityByTag[tag] ?? 'low';
      const files = [...new Set(arr.map((h) => h.file))];
      const sample = arr
        .slice(0, 5)
        .map((h) => `  - ${h.file}:${h.line} ${h.text.trim().slice(0, 100)}`)
        .join('\n');
      out.push({
        key: `todo:${p}:${tag}`,
        project: p,
        source: 'todo',
        category: tag === 'FIXME' || tag === 'BUG' ? 'bug' : 'tech-debt',
        severity: arr.length >= 20 ? 'high' : sev,
        title: `${p} 有 ${arr.length} 处 ${tag}（${files.length} 个文件）`,
        detail: `示例：\n${sample}\n\n共 ${arr.length} 处。建议归类处理或迁入 issue tracker。`,
        hint: `用 grep 全量列出 ${tag}，按文件聚类`,
        files: files.slice(0, 20),
        detectedAt: t,
      });
    }

    return out.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, ctx.limitPerScanner);
  }

  private collect(rootAbs: string, maxFiles: number): Hit[] {
    const out: Hit[] = [];
    let fileCount = 0;
    const stack = [rootAbs];
    while (stack.length > 0 && fileCount < maxFiles) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (DEFAULT_IGNORE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(full);
        } else if (e.isFile() && this.isSourceFile(e.name)) {
          fileCount++;
          try {
            const text = fs.readFileSync(full, 'utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              PATTERN.lastIndex = 0;
              const m = PATTERN.exec(lines[i]);
              if (m) {
                out.push({
                  file: path.relative(rootAbs, full).replace(/\\/g, '/'),
                  line: i + 1,
                  tag: m[1],
                  text: m[2],
                });
              }
            }
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    return out;
  }

  private isSourceFile(name: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|vue|svelte|md|sh|ps1|yaml|yml|toml|sql)$/i.test(name);
  }
}

function severityRank(s: IntentionSeed['severity']): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}
