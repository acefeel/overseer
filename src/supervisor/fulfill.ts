import { getLogger } from '../util/logger.js';
import { findProject } from '../projects/scanner.js';
import { ModePolicy } from '../daemon/mode.js';
import { ActionExecutor } from './actions.js';
import type { PendingApproval } from './approvals.js';

export interface FulfillResult {
  ok: boolean;
  approvalId: string;
  action: string;
  /** 已执行(no-op)的也返回 true,只有真正尝试执行但失败才返回 false */
  handled: boolean;
  error?: string;
  snapshotId?: string;
}

/**
 * 在 approval 被 decided='approved' 后执行实际的副作用动作。
 *
 * 当前支持:
 *  - file.delete:读取 approval.context.path,通过 ActionExecutor.deleteFile 删除。
 *  - shell.exec:读取 approval.context.command,通过 ActionExecutor.runShell 补跑。
 *
 * 不支持的 action(如 git.push)直接返回 ok=true / handled=false,只更新 approval 状态。
 *
 * 安全说明:
 *  - 即使是 daemon 当前处于 stopped/degraded 模式,只要用户显式 approved,
 *    fulfill 都按 'normal' 模式走 ActionExecutor 三道闸门(mode/manifest/protectedPaths)。
 *    理由:用户审批的优先级高于自主巡检的模式降级。
 *  - protectedPaths / allowWrite=false 仍然生效(自残防御),它们不受审批影响。
 *  - shell.exec 走 bypassGate 以豁免 allowExec 白名单(用户已显式批准该具体命令),
 *    但仍保留自动 snapshot,失败可 rollback。
 */
export async function fulfill(a: PendingApproval): Promise<FulfillResult> {
  const log = getLogger('fulfill');

  if (a.status !== 'approved') {
    return { ok: true, handled: false, approvalId: a.id, action: a.action };
  }

  if (a.action === 'file.delete') {
    const ctx = (a.context ?? {}) as Record<string, unknown>;
    const relPath = typeof ctx.path === 'string' ? ctx.path : undefined;
    if (!relPath) {
      log.warn({ id: a.id }, 'file.delete approval missing context.path, cannot fulfill');
      return {
        ok: false,
        handled: false,
        approvalId: a.id,
        action: a.action,
        error: 'approval context.path missing',
      };
    }

    const project = findProject(a.project);
    if (!project) {
      return {
        ok: false,
        handled: false,
        approvalId: a.id,
        action: a.action,
        error: `project not found: ${a.project}`,
      };
    }

    const executor = new ActionExecutor(project, new ModePolicy(), () => 'normal');
    const r = await executor.deleteFile(relPath);
    log.info(
      { id: a.id, project: a.project, relPath, ok: r.ok, snap: r.snapshot?.id, err: r.error },
      'fulfill file.delete'
    );
    return {
      ok: r.ok,
      handled: true,
      approvalId: a.id,
      action: a.action,
      error: r.error,
      snapshotId: r.snapshot?.id,
    };
  }

  if (a.action === 'shell.exec') {
    const ctx = (a.context ?? {}) as Record<string, unknown>;
    const command = typeof ctx.command === 'string' ? ctx.command : undefined;
    if (!command) {
      log.warn({ id: a.id }, 'shell.exec approval missing context.command, cannot fulfill');
      return {
        ok: false,
        handled: false,
        approvalId: a.id,
        action: a.action,
        error: 'approval context.command missing',
      };
    }

    const project = findProject(a.project);
    if (!project) {
      return {
        ok: false,
        handled: false,
        approvalId: a.id,
        action: a.action,
        error: `project not found: ${a.project}`,
      };
    }

    const executor = new ActionExecutor(project, new ModePolicy(), () => 'normal');
    // 用户已显式批准该具体命令 → 豁免 allowExec 白名单；仍保留 protectedPaths 与自动 snapshot
    const r = await executor.runShell(command, { bypassGate: true });
    log.info(
      { id: a.id, project: a.project, command, ok: r.ok, code: r.code, snap: r.snapshot?.id, err: r.error },
      'fulfill shell.exec'
    );
    return {
      ok: r.ok,
      handled: true,
      approvalId: a.id,
      action: a.action,
      error: r.error,
      snapshotId: r.snapshot?.id,
    };
  }

  log.info({ id: a.id, action: a.action }, 'no fulfillment implemented for this action');
  return { ok: true, handled: false, approvalId: a.id, action: a.action };
}
