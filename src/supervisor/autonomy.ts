import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import { loadConfig, type AppConfig } from '../util/config.js';
import { scanProjects } from '../projects/scanner.js';
import {
  scanAll,
  type AggregateOptions,
  type ScanResult,
  DEFAULT_ENABLED,
  MEDIUM_ENABLED,
  FULL_ENABLED,
} from '../scanners/index.js';
import * as queue from './queue.js';
import type { Intention } from './plan.js';
import { readAllIntentions } from './loop.js';
import type { Router } from '../providers/router.js';
import type { ModePolicy } from '../daemon/mode.js';
import type { SupervisionMode } from '../daemon/mode.js';
import type { BudgetPolicy } from '../budget/policy.js';
import { VaultRecorder } from '../kb/recorder.js';
import type { VaultWriter } from '../kb/writer.js';
import { PdcaeLoop } from './loop.js';

const CYCLE_LOG = path.join(PATHS.DATA_DIR, 'cycle-log.jsonl');

export type Aggressiveness = 'light' | 'normal' | 'full';

export interface CycleConfig {
  aggressiveness: Aggressiveness;
  /** 单 scanner 单 project 最多返回几条 */
  limitPerScanner: number;
  /** 一轮里是否真的执行队列顶项（design 阶段；不含 --execute） */
  autoExecute: boolean;
  /** 扫描时是否允许 spawn 子进程 */
  allowShellDuringScan: boolean;
  /** 仅扫描这些项目；空 = 全部 */
  onlyProjects: string[];
}

export const DEFAULT_CYCLE_CONFIG: CycleConfig = {
  aggressiveness: 'normal',
  limitPerScanner: 5,
  autoExecute: false,
  allowShellDuringScan: false,
  onlyProjects: [],
};

export interface CycleOutcome {
  startedAt: string;
  endedAt: string;
  mode: SupervisionMode;
  projects: { id: string; relPath: string; durationMs: number; perScanner: Record<string, number>; errors: Record<string, string> }[];
  queueBefore: number;
  queueAfter: number;
  added: number;
  updated: number;
  pruned: number;
  executed?: { queueId: string; status: string; designNote?: string; error?: string };
}

function aggressivenessToScanners(a: Aggressiveness): AggregateOptions['enabledScanners'] {
  if (a === 'light') return DEFAULT_ENABLED;
  if (a === 'full') return FULL_ENABLED;
  return MEDIUM_ENABLED;
}

export interface AutonomyDeps {
  router: Router;
  modePolicy: ModePolicy;
  budget: BudgetPolicy;
  writer: VaultWriter;
  recorder?: VaultRecorder;
  currentMode: () => SupervisionMode;
  recomputeMode: () => { decision: { mode: SupervisionMode }; changed: boolean };
}

/**
 * 一轮自主巡检：
 *   闸门（mode == normal?）→ 扫描所有项目 → 入队（去重）→ 选顶 → （可选）调 PDCAE 跑 design
 * 全程受 ModePolicy + BudgetPolicy 约束；非 normal 模式只做轻量记账，不执行。
 */
export class Autonomy {
  private log = getLogger('autonomy');
  readonly pdcae: PdcaeLoop;
  private recorder: VaultRecorder;

  constructor(public readonly deps: AutonomyDeps) {
    this.recorder = deps.recorder ?? new VaultRecorder(deps.writer);
    this.pdcae = new PdcaeLoop(
      deps.router,
      deps.modePolicy,
      deps.currentMode,
      deps.writer,
      (est) => deps.budget.canRunTask(est)
    );
    this.pdcae.setRecorder(this.recorder);
  }

  async runCycle(override?: Partial<CycleConfig>): Promise<CycleOutcome> {
    const cfg = loadConfig();
    const cc: CycleConfig = { ...this.cycleConfigFromMain(cfg), ...override };
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const modeDecision = this.deps.recomputeMode().decision;

    const out: CycleOutcome = {
      startedAt,
      endedAt: '',
      mode: modeDecision.mode,
      projects: [],
      queueBefore: queue.list().length,
      queueAfter: 0,
      added: 0,
      updated: 0,
      pruned: 0,
    };

    // 关键设计：扫描是 read-only，任何 mode（含 degraded/stopped）都可以跑
    // 只有 autoExecute 步骤（调 LLM 改代码）才需要 mode=normal
    // 这样"没配 GLM key 的开发期"也能持续看到 queue 在更新

    let projects = scanProjects();
    if (cc.onlyProjects.length > 0) {
      const want = new Set(cc.onlyProjects);
      projects = projects.filter((p) => want.has(p.id) || want.has(p.relPath));
    }

    const enabled = aggressivenessToScanners(cc.aggressiveness);
    // degraded/stopped 模式下不允许 spawn 子进程（npm outdated / test）
    // 但 git/todo 这种纯 fs 扫描器照跑
    const allowShell = cc.allowShellDuringScan && modeDecision.mode === 'normal';
    const actuallyEnabled = allowShell
      ? enabled
      : enabled.filter((s) => s === 'git' || s === 'todo');

    if (actuallyEnabled.length < enabled.length) {
      this.log.info(
        { mode: modeDecision.mode, dropped: enabled.filter((s) => !actuallyEnabled.includes(s)) },
        'some scanners skipped (require shell + normal mode)'
      );
    }

    const results: ScanResult[] = await scanAll(projects, {
      enabledScanners: actuallyEnabled,
      allowShell,
      limitPerScanner: cc.limitPerScanner,
    });

    const allSeeds = results.flatMap((r) => r.seeds);
    const merged = queue.enqueue(allSeeds);
    out.added = merged.added;
    out.updated = merged.updated;
    out.pruned = queue.prune(30);
    out.projects = results.map((r) => ({
      id: r.project,
      relPath: projects.find((p) => p.id === r.project)?.relPath ?? r.project,
      durationMs: r.durationMs,
      perScanner: r.perScanner,
      errors: r.errors,
    }));

    // 只有 normal 模式才允许自动执行（调 LLM 做 codegen）
    if (cc.autoExecute && modeDecision.mode === 'normal') {
      const next = queue.pickNext();
      if (next) {
        try {
          const r = await this.pdcae.executeIntention(this.toLegacyIntentionId(next));
          queue.setStatus(next.id, r.status === 'completed' ? 'design-generated' : 'pending', {
            notes: r.error ?? (r.detail as any),
          });
          out.executed = {
            queueId: next.id,
            status: r.status,
            designNote: r.designNoteRel,
            error: r.error,
          };
        } catch (e) {
          this.log.warn({ err: String(e), queueId: next.id }, 'auto-execute failed');
          out.executed = {
            queueId: next.id,
            status: 'failed',
            error: (e as Error).message,
          };
        }
      }
    } else if (cc.autoExecute && modeDecision.mode !== 'normal') {
      this.log.info(
        { mode: modeDecision.mode },
        'autoExecute skipped (requires normal mode); scanners still ran'
      );
    }

    out.queueAfter = queue.list().length;
    out.endedAt = new Date().toISOString();
    this.log.info(
      { mode: out.mode, projects: out.projects.length, added: out.added, queue: out.queueAfter, ms: Date.now() - t0 },
      'cycle done'
    );
    this.appendLog(out);
    return out;
  }

  /** queue item 没有 intentionId 时，临时合成一个，让 pdcae 当作 LLM 意向来跑 design */
  private toLegacyIntentionId(item: queue.QueueItem): string {
    // 把 queue item 当成 LLM 意向的"懒合成"：直接构造一个 Intention 写入 intentions.json
    const intent: Intention = {
      id: 'q-' + item.id,
      title: item.title,
      project: item.project,
      category: item.category,
      severity: item.severity,
      rationale: item.detail,
      proposedAction: item.hint ?? '(no hint)',
      estimatedTokens: 30_000,
      risks: [],
      source: 'scan',
      createdAt: item.firstSeen,
    };
    const all = readAllIntentions();
    if (!all.find((i) => i.id === intent.id)) {
      all.push(intent);
      fs.writeFileSync(
        path.join(PATHS.DATA_DIR, 'intentions.json'),
        JSON.stringify(all, null, 2),
        'utf8'
      );
    }
    return intent.id;
  }

  private cycleConfigFromMain(cfg: AppConfig): CycleConfig {
    const auto = (cfg as any).daemon?.autonomy;
    return {
      aggressiveness: auto?.aggressiveness ?? 'normal',
      limitPerScanner: auto?.limitPerScanner ?? 5,
      autoExecute: auto?.autoExecute ?? false,
      allowShellDuringScan: auto?.allowShellDuringScan ?? false,
      onlyProjects: auto?.onlyProjects ?? [],
    };
  }

  private appendLog(o: CycleOutcome): void {
    try {
      if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
      fs.appendFileSync(CYCLE_LOG, JSON.stringify(o) + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  }
}

export function readRecentCycles(limit = 10): CycleOutcome[] {
  if (!fs.existsSync(CYCLE_LOG)) return [];
  try {
    const lines = fs.readFileSync(CYCLE_LOG, 'utf8').split('\n').filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => JSON.parse(l) as CycleOutcome)
      .reverse();
  } catch {
    return [];
  }
}
