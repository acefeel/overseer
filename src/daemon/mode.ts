import { getLogger } from '../util/logger.js';
import type { BudgetSnapshot } from '../budget/policy.js';

/**
 * 三种监理模式：
 * - normal：主控 provider 可用且预算健康，可执行有副作用的动作（写文件 / commit / exec）。
 * - degraded：主控不可用（无 key / 失败）或预算进入 low/exhausted，切到 fallback（本地小模型）继续工作。
 *   该模式下仍允许执行动作，但受后续闸门约束：ProjectManifest.allowWrite / allowExec、protectedPaths、
 *   自动 snapshot、approvals。不是“只读”。
 * - stopped：主控不可用且没有 fallback；或预算耗尽且无 fallback。拒绝 LLM 调用，只保留 IPC/状态查询。
 */
export type SupervisionMode = 'normal' | 'degraded' | 'stopped';

export type ActionType =
  | 'read'
  | 'chat'
  | 'retrieve'
  | 'status'
  | 'plan'
  | 'design'
  | 'evaluate'
  | 'judge'
  | 'memory.write'
  | 'file.write'
  | 'file.delete'
  | 'git.commit'
  | 'git.push'
  | 'shell.exec';

const DEGRADED_ALLOW: ReadonlySet<ActionType> = new Set<ActionType>([
  // M5 设计：degraded 模式由 fallback（本地 worker）继续处理任务。
  // 安全不再由 mode 层一刀切禁止，而是交给：
  //   1) ProjectManifest.allowWrite / allowExec / protectedPaths
  //   2) ActionExecutor 的自动 snapshot
  //   3) approvals 审批（高危动作）
  // 这里列出所有动作以明确 degraded 模式下均可进入后续闸门评估。
  'read',
  'chat',
  'retrieve',
  'status',
  'plan',
  'design',
  'evaluate',
  'judge',
  'memory.write',
  'file.write',
  'file.delete',
  'git.commit',
  'git.push',
  'shell.exec',
]);

const NORMAL_BLOCKED: ReadonlySet<ActionType> = new Set<ActionType>([]);

export interface ModeDecision {
  mode: SupervisionMode;
  reason: string;
  fromLevel: BudgetSnapshot['level'];
  /** 触发降级的具体原因分类，便于审计/展示 */
  trigger: 'budget' | 'no-main' | 'fallback-down' | 'normal' | 'no-fallback';
  /** 携带完整预算快照，便于调用方直接做精细化决策 */
  snapshot: BudgetSnapshot;
}

export class ModePolicy {
  private log = getLogger('mode');

  /**
   * 由预算快照 + 主链是否可用 + fallback 是否可用推导当前模式。
   *
   * - 主链不可用（无 key/未启用/全失败）也视为该切 fallback，不止预算耗尽
   * - mode=normal 必须同时满足：主链可用 AND 预算 ok/caution
   */
  decide(
    snap: BudgetSnapshot,
    mainReady: boolean,
    hasFallback: boolean
  ): ModeDecision {
    const budgetOk = snap.level === 'ok' || snap.level === 'caution';

    if (mainReady && budgetOk) {
      return {
        mode: 'normal',
        reason: `main ready, budget ${snap.level}`,
        fromLevel: snap.level,
        trigger: 'normal',
        snapshot: snap,
      };
    }

    if (hasFallback) {
      const why = !mainReady
        ? `main not ready (${snap.level}), using fallback worker`
        : `budget ${snap.level}, switching to fallback worker`;
      return {
        mode: 'degraded',
        reason: why,
        fromLevel: snap.level,
        trigger: !mainReady ? 'no-main' : 'budget',
        snapshot: snap,
      };
    }

    return {
      mode: 'stopped',
      reason: !mainReady
        ? `main not ready and no fallback available`
        : `budget ${snap.level} and no fallback provider available`,
      fromLevel: snap.level,
      trigger: 'no-fallback',
      snapshot: snap,
    };
  }

  canPerform(action: ActionType, mode: SupervisionMode): { ok: boolean; reason?: string } {
    if (mode === 'normal') {
      if (NORMAL_BLOCKED.has(action)) {
        return { ok: false, reason: `action ${action} blocked by policy` };
      }
      return { ok: true };
    }
    if (mode === 'degraded') {
      if (DEGRADED_ALLOW.has(action)) return { ok: true };
      return {
        ok: false,
        reason: `degraded mode: ${action} is not in the allow-list`,
      };
    }
    return { ok: false, reason: `stopped mode: no LLM actions allowed` };
  }

  onTransition(prev: SupervisionMode, next: SupervisionMode, decision: ModeDecision): void {
    if (prev === next) return;
    this.log.warn(
      { from: prev, to: next, reason: decision.reason, trigger: decision.trigger },
      'supervision mode transition'
    );
  }
}

export const DEGRADED_BANNER =
  '⚠ [降级模式] 已切换到本地 fallback（worker 模式）。' +
  '动作仍受 ProjectManifest、受保护路径、自动快照与审批闸门约束。' +
  '主控恢复（key 配好或预算重置）后自动切回。\n\n';

/** 触发原因 → 友好提示，拼到 banner 后面 */
export function degradedReasonLine(trigger: 'budget' | 'no-main' | 'fallback-down'): string {
  if (trigger === 'no-main') {
    return '> 触发：主控 provider 未就绪（无 apiKey 或 disabled）。配好 key 后自动切回主控。\n\n';
  }
  if (trigger === 'budget') {
    return '> 触发：主控预算逼近上限。跨日/跨周重置后自动切回主控。\n\n';
  }
  return '> 触发：主控链不可用。fallback 维持期间可继续处理任务，动作受后续安全闸门约束。\n\n';
}
