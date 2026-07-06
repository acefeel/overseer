import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import type { ProjectInfo } from '../projects/scanner.js';
import { readManifest } from '../projects/manifest.js';
import { ProjectGit } from '../vcs/git.js';
import { Snapshotter, type Snapshot } from '../vcs/snapshot.js';
import { Rollback } from '../vcs/rollback.js';
import type { ModePolicy } from '../daemon/mode.js';
import type { SupervisionMode } from '../daemon/mode.js';
import { isProtected } from '../util/glob.js';
import * as approvals from './approvals.js';
import { VaultRecorder } from '../kb/recorder.js';

export interface ActionResult {
  ok: boolean;
  action: string;
  project: string;
  snapshot?: Snapshot;
  error?: string;
  approval?: { id: string; status: string };
  detail?: unknown;
}

export interface ExecOptions {
  /** 强制跳过 mode/policy 闸门（仅 CLI 直跑命令时用） */
  bypassGate?: boolean;
  /** 强制跳过 snapshot（dry-run 评估、纯读时用） */
  skipSnapshot?: boolean;
  /** 高危动作不创建 approval，直接拒绝 */
  noApproval?: boolean;
  /** 把动作结果写入 vault（默认 true） */
  recordVault?: boolean;
}

/**
 * 统一的"动作执行器"。所有有副作用的操作（file.write / shell.exec / git.commit）都走它。
 *
 * 三道闸门（按顺序）：
 * 1. ModePolicy.canPerform(action, mode) — degraded/stopped 直接拒
 * 2. ProjectManifest.allowWrite + allowExec + requiresApproval — per-project 策略
 * 3. Approvals — 高危动作挂起，等 CLI approve
 *
 * 通过后：
 * 1. Snapshotter.take()（除非 skipSnapshot）
 * 2. 执行真实动作
 * 3. 返回 ActionResult（含 snapshot id，用于失败时 rollback）
 */
export class ActionExecutor {
  private log = getLogger('actions');
  readonly git: ProjectGit;
  readonly snapshotter: Snapshotter;
  readonly rollback: Rollback;
  private recorder?: VaultRecorder;

  constructor(
    public readonly project: ProjectInfo,
    public readonly modePolicy: ModePolicy,
    public readonly currentMode: () => SupervisionMode,
    recorder?: VaultRecorder
  ) {
    this.git = new ProjectGit(project.rootAbs);
    this.snapshotter = new Snapshotter(this.git);
    this.rollback = new Rollback(this.git);
    this.recorder = recorder;
  }

  setRecorder(recorder: VaultRecorder): void {
    this.recorder = recorder;
  }

  private gate(action: string, opts: ExecOptions): { ok: boolean; reason?: string } {
    if (opts.bypassGate) return { ok: true };
    const mode = this.currentMode();
    const policy = this.modePolicy.canPerform(action as any, mode);
    if (!policy.ok) {
      return { ok: false, reason: `mode=${mode} blocked ${action}: ${policy.reason}` };
    }
    return { ok: true };
  }

  private record(action: string, result: ActionResult, opts: ExecOptions): void {
    if (opts.recordVault === false) return;
    if (!this.recorder) return;
    void this.recorder.actionEvent(this.project.id, action, {
      ok: result.ok,
      error: result.error,
      detail: {
        snapshotId: result.snapshot?.id,
        approval: result.approval,
        code: (result as any).code,
      },
    });
  }

  async writeFile(relPath: string, content: string, opts: ExecOptions = {}): Promise<ActionResult> {
    const action = 'file.write';
    const g = this.gate(action, opts);
    if (!g.ok) {
      const r = this.fail(action, g.reason!);
      this.record(action, r, opts);
      return r;
    }

    const manifest = readManifest(this.project.rootAbs);
    if (!manifest.allowWrite && !opts.bypassGate) {
      const r = this.fail(action, `project ${this.project.id} has allowWrite=false (set .overseer.json)`);
      this.record(action, r, opts);
      return r;
    }

    const rel = path.isAbsolute(relPath)
      ? path.relative(this.project.rootAbs, relPath)
      : relPath;
    const protectedHit = isProtected(rel.replace(/\\/g, '/'), manifest.protectedPaths);
    if (protectedHit && !opts.bypassGate) {
      const r = this.fail(
        action,
        `refuse to modify protected path "${rel}" (matches manifest.protectedPaths). Self-protection.`
      );
      this.record(action, r, opts);
      return r;
    }

    let snap: Snapshot | undefined;
    if (!opts.skipSnapshot) {
      try {
        snap = await this.snapshotter.take(`before ${action}: ${relPath}`);
      } catch (e) {
        const r = this.fail(action, `snapshot failed: ${(e as Error).message}`);
        this.record(action, r, opts);
        return r;
      }
    }

    try {
      const abs = path.isAbsolute(relPath) ? relPath : path.join(this.project.rootAbs, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
      this.log.info({ project: this.project.id, relPath, snap: snap?.id }, 'file written');
      const r: ActionResult = { ok: true, action, project: this.project.id, snapshot: snap };
      this.record(action, r, opts);
      return r;
    } catch (e) {
      const r = this.fail(action, (e as Error).message, snap);
      this.record(action, r, opts);
      return r;
    }
  }

  async deleteFile(relPath: string, opts: ExecOptions = {}): Promise<ActionResult> {
    const action = 'file.delete';
    const g = this.gate(action, opts);
    if (!g.ok) {
      const r = this.fail(action, g.reason!);
      this.record(action, r, opts);
      return r;
    }

    const manifest = readManifest(this.project.rootAbs);
    if (!manifest.allowWrite && !opts.bypassGate) {
      const r = this.fail(
        action,
        `project ${this.project.id} has allowWrite=false (set .overseer.json)`
      );
      this.record(action, r, opts);
      return r;
    }

    const rel = path.isAbsolute(relPath)
      ? path.relative(this.project.rootAbs, relPath)
      : relPath;
    const protectedHit = isProtected(rel.replace(/\\/g, '/'), manifest.protectedPaths);
    if (protectedHit && !opts.bypassGate) {
      const r = this.fail(
        action,
        `refuse to delete protected path "${rel}" (matches manifest.protectedPaths). Self-protection.`
      );
      this.record(action, r, opts);
      return r;
    }

    const abs = path.isAbsolute(relPath) ? relPath : path.join(this.project.rootAbs, relPath);
    if (!fs.existsSync(abs)) {
      const r = this.fail(action, `file not found: ${rel}`);
      this.record(action, r, opts);
      return r;
    }

    let snap: Snapshot | undefined;
    if (!opts.skipSnapshot) {
      try {
        // 用 noStash:true —— 默认 stash 会把待删的 untracked 文件一起 stash 走,
        // 导致后续 unlinkSync 失败。gitCommit 也是同样处理。
        snap = await this.snapshotter.take(`before ${action}: ${relPath}`, undefined, { noStash: true });
      } catch (e) {
        const r = this.fail(action, `snapshot failed: ${(e as Error).message}`);
        this.record(action, r, opts);
        return r;
      }
    }

    try {
      fs.unlinkSync(abs);
      this.log.info({ project: this.project.id, relPath, snap: snap?.id }, 'file deleted');
      const r: ActionResult = { ok: true, action, project: this.project.id, snapshot: snap };
      this.record(action, r, opts);
      return r;
    } catch (e) {
      const r = this.fail(action, (e as Error).message, snap);
      this.record(action, r, opts);
      return r;
    }
  }

  async runShell(command: string, opts: ExecOptions = {}): Promise<ActionResult & { stdout?: string; stderr?: string; code?: number }> {
    const action = 'shell.exec';
    const g = this.gate(action, opts);
    if (!g.ok) {
      const r = { ...this.fail(action, g.reason!), stdout: '', stderr: g.reason, code: 1 };
      this.record(action, r, opts);
      return r;
    }

    const manifest = readManifest(this.project.rootAbs);
    const allowed = manifest.allowExec.some((prefix) => command.startsWith(prefix));
    if (!allowed && !opts.bypassGate) {
      const appr = approvals.create({
        project: this.project.id,
        action,
        description: command,
        context: { command, manifestAllowExec: manifest.allowExec },
      });
      this.log.warn({ approvalId: appr.id, command }, 'shell.exec needs approval');
      const r = {
        ok: false,
        action,
        project: this.project.id,
        error: `command not in allowExec list; approval ${appr.id} created`,
        approval: { id: appr.id, status: 'pending' },
        stdout: '',
        stderr: 'pending approval',
        code: 126,
      };
      this.record(action, r, opts);
      return r;
    }

    let snap: Snapshot | undefined;
    if (!opts.skipSnapshot) {
      try {
        snap = await this.snapshotter.take(`before ${action}: ${command}`);
      } catch (e) {
        const r = { ...this.fail(action, `snapshot failed: ${(e as Error).message}`), stdout: '', stderr: (e as Error).message, code: 1 };
        this.record(action, r, opts);
        return r;
      }
    }

    try {
      const { spawn } = await import('node:child_process');
      const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
        const child = spawn(command, {
          cwd: this.project.rootAbs,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => (stdout += d.toString()));
        child.stderr?.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
        child.on('error', (e) => resolve({ stdout, stderr: e.message, code: 1 }));
      });
      this.log.info(
        { project: this.project.id, command, code: result.code, snap: snap?.id },
        'shell done'
      );
      const r = {
        ok: result.code === 0,
        action,
        project: this.project.id,
        snapshot: snap,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
      };
      this.record(action, r, opts);
      return r;
    } catch (e) {
      const r = {
        ...this.fail(action, (e as Error).message, snap),
        stdout: '',
        stderr: (e as Error).message,
        code: 1,
      };
      this.record(action, r, opts);
      return r;
    }
  }

  async gitCommit(message: string, opts: ExecOptions = {}): Promise<ActionResult> {
    const action = 'git.commit';
    const g = this.gate(action, opts);
    if (!g.ok) {
      const r = this.fail(action, g.reason!);
      this.record(action, r, opts);
      return r;
    }

    const manifest = readManifest(this.project.rootAbs);
    if (!manifest.allowWrite && !opts.bypassGate) {
      const r = this.fail(action, `project ${this.project.id} has allowWrite=false`);
      this.record(action, r, opts);
      return r;
    }

    let snap: Snapshot | undefined;
    if (!opts.skipSnapshot) {
      try {
        snap = await this.snapshotter.take(`before ${action}: ${message}`, undefined, { noStash: true });
      } catch (e) {
        const r = this.fail(action, `snapshot failed: ${(e as Error).message}`);
        this.record(action, r, opts);
        return r;
      }
    }

    try {
      await this.git.addAll();
      const sha = await this.git.commit(`[overseer] ${message}`);
      this.log.info({ project: this.project.id, sha: sha.slice(0, 8), snap: snap?.id }, 'committed');
      const r: ActionResult = { ok: true, action, project: this.project.id, snapshot: snap, detail: { sha } };
      this.record(action, r, opts);
      return r;
    } catch (e) {
      const r = this.fail(action, (e as Error).message, snap);
      this.record(action, r, opts);
      return r;
    }
  }

  async rollbackTo(snapId: string): Promise<ActionResult> {
    try {
      const r = await this.rollback.to(snapId);
      return {
        ok: r.ok,
        action: 'rollback',
        project: this.project.id,
        snapshot: r.snap,
        error: r.error,
        detail: { resetCommits: r.resetCommits, restoredStash: r.restoredStash },
      };
    } catch (e) {
      return this.fail('rollback', (e as Error).message);
    }
  }

  private fail(action: string, error: string, snap?: Snapshot): ActionResult {
    this.log.error({ project: this.project.id, action, err: error }, 'action failed');
    return { ok: false, action, project: this.project.id, snapshot: snap, error };
  }
}
