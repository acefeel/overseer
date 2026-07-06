import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Scanner, ScannerContext, IntentionSeed } from './base.js';
import { nowIso } from './base.js';

interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  dependent?: string;
  type: 'major' | 'minor' | 'patch';
}

/**
 * 扫描 package.json 依赖过期。
 * medium（spawn 一次 `npm outdated --json`，~3-10s）。
 */
export class OutdatedScanner implements Scanner {
  readonly id = 'outdated';
  readonly description = 'npm outdated 依赖过期扫描';
  readonly cost = 'medium' as const;

  async scan(ctx: ScannerContext): Promise<IntentionSeed[]> {
    if (!ctx.allowShell) return [];
    const pkgPath = path.join(ctx.project.rootAbs, 'package.json');
    if (!fs.existsSync(pkgPath)) return [];

    const outdated = await this.runNpmOutdated(ctx.project.rootAbs);
    if (outdated.size === 0) return [];

    const p = ctx.project.id;
    const t = nowIso();
    const majors = [...outdated.values()].filter((x) => x.type === 'major');
    const minors = [...outdated.values()].filter((x) => x.type === 'minor');

    const out: IntentionSeed[] = [];

    if (majors.length > 0) {
      const top = majors
        .sort((a, b) => severityHeuristic(b) - severityHeuristic(a))
        .slice(0, 8);
      const list = top
        .map((x) => `  - ${x.name}: ${x.current} → ${x.latest}${x.dependent ? ` (依赖 ${x.dependent})` : ''}`)
        .join('\n');
      out.push({
        key: `outdated:major:${p}`,
        project: p,
        source: 'outdated',
        category: 'security',
        severity: majors.length >= 10 ? 'high' : 'medium',
        title: `${p} 有 ${majors.length} 个依赖主版本落后`,
        detail: `主版本落后往往伴随 breaking change 和安全补丁。top：\n${list}`,
        hint: '逐个看 changelog；先升 patch/minor，再分批升 major；测试覆盖要先行',
        files: ['package.json', 'package-lock.json'],
        detectedAt: t,
      });
    }

    if (minors.length >= 10) {
      out.push({
        key: `outdated:minor:${p}`,
        project: p,
        source: 'outdated',
        category: 'tech-debt',
        severity: 'low',
        title: `${p} 有 ${minors.length} 个依赖次版本落后`,
        detail: '通常兼容，可一次性 `npm update`。',
        hint: '`npm update` 后跑测试',
        files: ['package.json'],
        detectedAt: t,
      });
    }

    return out.slice(0, ctx.limitPerScanner);
  }

  private async runNpmOutdated(rootAbs: string): Promise<Map<string, OutdatedPackage>> {
    return new Promise((resolve) => {
      // Windows 上 PATH 里是 npm.cmd；其它平台是 npm。spawn(shell:false) 需精确名。
      const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npmBin, ['outdated', '--json'], {
        cwd: rootAbs,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.on('close', () => {
        try {
          const obj = JSON.parse(stdout || '{}') as Record<string, any>;
          const out = new Map<string, OutdatedPackage>();
          for (const [name, info] of Object.entries(obj)) {
            const current = String(info.current ?? '?');
            const latest = String(info.latest ?? '?');
            if (current === '?' || latest === '?') continue;
            const type = majorDiff(current, latest)
              ? 'major'
              : minorDiff(current, latest)
              ? 'minor'
              : 'patch';
            out.set(name, {
              name,
              current,
              wanted: String(info.wanted ?? current),
              latest,
              dependent: info.dependent,
              type,
            });
          }
          resolve(out);
        } catch {
          resolve(new Map());
        }
      });
      child.on('error', () => resolve(new Map()));
    });
  }
}

function majorDiff(a: string, b: string): boolean {
  return num(a, 0) !== num(b, 0);
}
function minorDiff(a: string, b: string): boolean {
  return num(a, 1) !== num(b, 1);
}
function num(v: string, idx: number): number {
  const clean = v.replace(/^[^0-9]+/, '');
  const n = parseInt(clean.split('.')[idx] ?? '0', 10);
  return isNaN(n) ? 0 : n;
}
function severityHeuristic(p: OutdatedPackage): number {
  const gap = num(p.latest, 0) - num(p.current, 0);
  return gap;
}
