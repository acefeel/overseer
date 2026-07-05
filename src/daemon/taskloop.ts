import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ModeDecision, ModePolicy } from './mode.js';
import type { SupervisionMode } from './mode.js';
import type { BudgetPolicy } from '../budget/policy.js';
import type { VaultWriter } from '../kb/writer.js';
import { findProject, scanProjects } from '../projects/scanner.js';
import { readManifest } from '../projects/manifest.js';
import {
  scanAll,
  DEFAULT_ENABLED,
  MEDIUM_ENABLED,
  FULL_ENABLED,
  type ScanResult,
} from '../scanners/index.js';
import * as queue from '../supervisor/queue.js';
import * as approvals from '../supervisor/approvals.js';
import { PdcaeLoop } from '../supervisor/loop.js';
import { Consultant } from '../supervisor/consultant.js';
import { DataRetention } from '../vcs/retention.js';

export type LoopState =
  | 'idle'           // 还没启动
  | 'running'        // 正在跑任务
  | 'scanning'       // 正在扫描项目
  | 'consulting'     // 正在问 consultant 是否 milestone
  | 'resting'        // 全部 milestone，等用户指令
  | 'paused'         // 用户手动暂停
  | 'error';

export interface ProjectMilestone {
  projectId: string;
  reached: boolean;
  reason: string;
  ts: string;
  consultantVerified: boolean;
}

export interface TaskLoopSnapshot {
  state: LoopState;
  currentTaskId?: string;
  currentTaskTitle?: string;
  currentProject?: string;
  pendingCount: number;
  milestones: ProjectMilestone[];
  lastCycleAt?: string;
  lastConsultantCheckAt?: string;
  lastError?: string;
  iterationsCompleted: number;
}

interface TaskLoopDeps {
  router: Router;
  modePolicy: ModePolicy;
  budget: BudgetPolicy;
  writer: VaultWriter;
  currentMode: () => SupervisionMode;
  recomputeMode: () => { decision: ModeDecision; changed: boolean };
}

const TICK_MS = 1500; // 任务之间间隔（很短，让 TUI 能反应过来 + 让 IPC 不堵）

/**
 * 连续任务循环：
 *
 *   while not paused:
 *     if mode == stopped: rest
 *     if queue 有 pending:
 *       run task (worker); on block → escalate to consultant
 *     else:
 *       for each project not at milestone:
 *         ask consultant "anything else?"
 *         if suggestions → enqueue + unmark milestone
 *         else → mark milestone
 *       if all projects at milestone → rest, wait for user resume
 *
 * "用户下达命令" = chat 时 supervisor 调 taskloop.resume()
 */
export class TaskLoop {
  private log = getLogger('taskloop');
  readonly pdcae: PdcaeLoop;
  readonly consultant: Consultant;

  private state: LoopState = 'idle';
  private currentTask?: { id: string; title: string; project: string };
  private milestones = new Map<string, ProjectMilestone>();
  private lastCycleAt?: string;
  private lastConsultantCheckAt?: string;
  private lastError?: string;
  private iterationsCompleted = 0;
  private running = false;
  private resumeResolver?: () => void;
  private stopRequested = false;
  private aggressiveness: 'light' | 'normal' | 'full' = 'normal';

  constructor(private readonly deps: TaskLoopDeps) {
    this.pdcae = new PdcaeLoop(
      deps.router,
      deps.modePolicy,
      deps.currentMode,
      deps.writer,
      (est: number) => deps.budget.canRunTask(est)
    );
    this.consultant = new Consultant(deps.router);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.state = 'running';
    this.log.info('task loop started (continuous)');
    this.tick().catch((e) => {
      this.log.error({ err: String(e) }, 'task loop crashed');
      this.state = 'error';
      this.lastError = (e as Error).message;
    });
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    this.state = 'paused';
    // 唤醒可能在等待的 rest 状态
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = undefined;
    }
    this.log.info('task loop stopped');
  }

  /** 外部触发：用户 chat / 添加任务时调用，唤醒 resting 状态 */
  resume(): void {
    this.log.info('task loop resumed by external trigger');
    // 清除所有 milestone 标记（用户有新动作 = 重新评估）
    for (const [k, v] of this.milestones) {
      this.milestones.set(k, { ...v, reached: false, reason: 'resumed by user', ts: new Date().toISOString() });
    }
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = undefined;
    }
    if (!this.running) {
      this.start();
    }
  }

  snapshot(): TaskLoopSnapshot {
    return {
      state: this.state,
      currentTaskId: this.currentTask?.id,
      currentTaskTitle: this.currentTask?.title,
      currentProject: this.currentTask?.project,
      pendingCount: queue.listPending().length,
      milestones: [...this.milestones.values()].sort((a, b) => a.projectId.localeCompare(b.projectId)),
      lastCycleAt: this.lastCycleAt,
      lastConsultantCheckAt: this.lastConsultantCheckAt,
      lastError: this.lastError,
      iterationsCompleted: this.iterationsCompleted,
    };
  }

  private async tick(): Promise<void> {
    while (this.running && !this.stopRequested) {
      try {
        await this.iterate();
      } catch (e) {
        this.log.error({ err: String(e) }, 'iterate failed');
        this.lastError = (e as Error).message;
        this.state = 'error';
        await sleep(10_000); // 出错后等 10s 再重试
        this.state = this.stopRequested ? 'paused' : 'running';
      }
      await sleep(TICK_MS);
    }
    this.log.info('task loop exited');
  }

  private async iterate(): Promise<void> {
    const { decision } = this.deps.recomputeMode();
    if (decision.mode === 'stopped') {
      this.state = 'resting';
      this.lastError = 'mode=stopped, no provider available';
      await this.waitExternal('stopped');
      return;
    }

    // 低预算时只处理 tiny tasks，避免大任务把剩余预算吃光
    if (decision.mode === 'degraded' || decision.snapshot.recommendation === 'pause') {
      const next = queue.pickNext();
      if (next) {
        // 估算任务大小（复用 PdcaeLoop 内部逻辑）
        const project = findProject(next.project);
        const manifest = project ? readManifest(project.rootAbs) : null;
        const base = manifest?.allowWrite ? 30_000 : 6_000;
        const estimated = base + (next.files?.length ?? 0) * 1_200;
        if (estimated > decision.snapshot.safetyPad) {
          this.state = 'resting';
          this.lastError = `budget ${decision.snapshot.level}: skip large task ${estimated} tokens`;
          this.log.warn({ task: next.id, estimated }, this.lastError);
          await this.waitExternal('stopped');
          return;
        }
      }
    }

    // 1. 取下一个 pending 任务
    const next = queue.pickNext();
    if (next) {
      // 有活干
      this.state = 'running';
      this.currentTask = { id: next.id, title: next.title, project: next.project };
      this.log.info({ id: next.id, title: next.title.slice(0, 60) }, 'task picked');

      try {
        const r = await this.pdcae.executeQueueItem({
          id: next.id,
          title: next.title,
          project: next.project,
          category: next.category as any,
          severity: next.severity as any,
          detail: next.detail,
          hint: next.hint,
          files: next.files,
          status: next.status,
          firstSeen: next.firstSeen,
          lastSeen: next.lastSeen,
          dedupe: next.dedupe,
          source: next.source as any,
        });
        if (r.status === 'completed' || r.status === 'skipped') {
          queue.setStatus(next.id, r.status === 'skipped' ? 'abandoned' : 'done', {
            notes: r.error ?? JSON.stringify(r.detail ?? {}).slice(0, 200),
            intentionId: 'q-' + next.id,
          });
          this.iterationsCompleted++;
          // 任务完成（含 design-only）→ 该项目还有事做（产出 design 也算进展）
          // 不清 milestone；等 consultant 决定
        } else if (r.status === 'failed' || r.status === 'rolled-back') {
          // worker 卡住 → 升级到 consultant
          this.state = 'consulting';
          const esc = await this.consultant.escalate(
            { id: next.project, name: next.project, rootAbs: '', relPath: next.project, isGitRepo: false, hasManifest: false, detectedBy: [] } as any,
            { title: next.title, rationale: next.detail, proposedAction: next.hint ?? '' },
            r.error ?? 'unknown failure',
          );
          this.log.info({ resolved: esc.resolved, override: esc.needsConsultantOverride }, 'escalation result');
          if (esc.resolved) {
            queue.setStatus(next.id, 'pending', { notes: `consultant hint: ${esc.approach.slice(0, 200)}` });
          } else {
            queue.setStatus(next.id, 'abandoned', { notes: `consultant couldn't resolve: ${esc.approach.slice(0, 200)}` });
          }
        }
      } catch (e) {
        this.log.warn({ err: String(e), id: next.id }, 'task threw');
        queue.setStatus(next.id, 'abandoned', { notes: `exception: ${(e as Error).message}` });
      } finally {
        this.currentTask = undefined;
      }
      return;
    }

    // 2. 队列空 → 检查各项目 milestone
    const projects = scanProjects().filter((p) => p.detectedBy.length > 0);
    const needCheck = projects.filter((p) => {
      const m = this.milestones.get(p.id);
      return !m || !m.reached || !m.consultantVerified;
    });

    if (needCheck.length === 0) {
      // 全部 milestone → 休息
      this.state = 'resting';
      this.log.info({ milestones: this.milestones.size }, 'all projects at milestone, resting');
      await this.waitExternal('milestone');
      return;
    }

    // 3. 对每个待审项目：先扫，再问 consultant
    this.state = 'scanning';
    const enabled =
      this.aggressiveness === 'light'
        ? DEFAULT_ENABLED
        : this.aggressiveness === 'full'
        ? FULL_ENABLED
        : MEDIUM_ENABLED;
    const allowShell = decision.mode === 'normal' && this.deps.router.hasWorker();
    const scanResults: ScanResult[] = await scanAll(needCheck, {
      enabledScanners: allowShell ? enabled : enabled.filter((s) => s === 'git' || s === 'todo'),
      allowShell,
      limitPerScanner: 5,
    });
    const seeds = scanResults.flatMap((r) => r.seeds);
    if (seeds.length > 0) {
      queue.enqueue(seeds);
      this.log.info({ added: seeds.length }, 'scanner found new issues during milestone check');
      // 找到新活，继续跑
      return;
    }

    // 4. 没新扫描结果，问 consultant
    this.state = 'consulting';
    this.lastConsultantCheckAt = new Date().toISOString();
    for (const p of needCheck) {
      try {
        const review = await this.consultant.reviewProject(p);
        if (review.suggestions.length > 0) {
          queue.enqueue(review.suggestions);
          this.clearMilestone(p.id);
          this.log.info({ project: p.id, newItems: review.suggestions.length }, 'consultant found more work');
        } else {
          this.setMilestone(p.id, review.reached, review.reason, true);
          this.log.info({ project: p.id, reached: review.reached, reason: review.reason }, 'consultant milestone verdict');
        }
      } catch (e) {
        this.log.warn({ err: String(e), project: p.id }, 'consultant review failed');
      }
    }
    this.lastCycleAt = new Date().toISOString();
    this.iterationsCompleted++;

    // 每 10 次迭代做一次数据清理
    if (this.iterationsCompleted % 10 === 0) {
      try {
        const retention = new DataRetention();
        await retention.run();
        const expired = approvals.expirePending(30);
        if (expired > 0) {
          this.log.info({ expired }, 'expired stale approvals');
        }
      } catch (e) {
        this.log.warn({ err: String(e) }, 'retention run failed');
      }
    }
  }

  private async waitExternal(_reason: 'milestone' | 'stopped'): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resumeResolver = resolve;
    });
  }

  private setMilestone(projectId: string, reached: boolean, reason: string, consultantVerified = false): void {
    this.milestones.set(projectId, {
      projectId,
      reached,
      reason,
      ts: new Date().toISOString(),
      consultantVerified,
    });
  }

  private clearMilestone(projectId: string): void {
    this.milestones.delete(projectId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
