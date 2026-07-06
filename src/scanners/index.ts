import { LintScanner } from './lint.js';
import { getLogger } from '../util/logger.js';
import type { ProjectInfo } from '../projects/scanner.js';
import type { IntentionSeed, Scanner, ScannerContext } from './base.js';
import { GitScanner } from './git.js';
import { TodoScanner } from './todo.js';
import { OutdatedScanner } from './outdated.js';
import { TestScanner } from './test.js';

export * from './base.js';

export interface AggregateOptions {
  /** 启用哪些 scanner */
  enabledScanners: Array<Scanner['id']>;
  /** 是否允许 spawn 子进程（npm outdated / test） */
  allowShell: boolean;
  /** 单 scanner 在单 project 上返回的最大条数 */
  limitPerScanner: number;
}

export const DEFAULT_ENABLED: Scanner['id'][] = ['git', 'todo'];
export const MEDIUM_ENABLED: Scanner['id'][] = ['git', 'todo', 'outdated'];
export const FULL_ENABLED: Scanner['id'][] = ['git', 'todo', 'outdated', 'test', 'lint'];

const REGISTRY: Record<Scanner['id'], () => Scanner> = {
  git: () => new GitScanner(),
  todo: () => new TodoScanner(),
  outdated: () => new OutdatedScanner(),
  test: () => new TestScanner(),
  lint: () => new LintScanner(),
  manual: () => new GitScanner(), // 不应被自动调用
  'llm-plan': () => new GitScanner(), // 不应被自动调用
};

export interface ScanResult {
  project: string;
  startedAt: string;
  durationMs: number;
  seeds: IntentionSeed[];
  perScanner: Record<string, number>;
  errors: Record<string, string>;
}

export async function scanProject(
  project: ProjectInfo,
  opts: AggregateOptions
): Promise<ScanResult> {
  const log = getLogger('scanner');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const seeds: IntentionSeed[] = [];
  const perScanner: Record<string, number> = {};
  const errors: Record<string, string> = {};

  for (const id of opts.enabledScanners) {
    const factory = REGISTRY[id];
    if (!factory) {
      log.warn({ scanner: id }, 'unknown scanner, skipping');
      continue;
    }
    const scanner = factory();
    const ctx: ScannerContext = {
      project,
      allowShell: opts.allowShell,
      limitPerScanner: opts.limitPerScanner,
    };
    try {
      const out = await scanner.scan(ctx);
      perScanner[id] = out.length;
      seeds.push(...out);
    } catch (e) {
      errors[id] = (e as Error).message;
      perScanner[id] = 0;
      log.warn({ scanner: id, err: String(e) }, 'scanner failed');
    }
  }

  return {
    project: project.id,
    startedAt,
    durationMs: Date.now() - t0,
    seeds,
    perScanner,
    errors,
  };
}

export async function scanAll(
  projects: ProjectInfo[],
  opts: AggregateOptions
): Promise<ScanResult[]> {
  const results: ScanResult[] = [];
  for (const p of projects) {
    results.push(await scanProject(p, opts));
  }
  return results;
}
