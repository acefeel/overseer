import fs from 'node:fs';
import path from 'node:path';
import type { IntentionSeed } from '../scanners/base.js';
import { SeedElevator } from './seed-elevator.js';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import type { Router } from '../providers/router.js';
import type { ModePolicy } from '../daemon/mode.js';
import type { SupervisionMode } from '../daemon/mode.js';
import type { VaultWriter } from '../kb/writer.js';
import { findProject, type ProjectInfo } from '../projects/scanner.js';
import { readManifest } from '../projects/manifest.js';
import { IntentionGenerator, type Intention } from './plan.js';
import { ActionExecutor } from './actions.js';
import { CodeChangeGenerator, type FileChange } from './codegen.js';
import * as approvals from './approvals.js';
import type { QueueItem } from './queue.js';

export interface CycleResult {
  project: string;
  phase: 'plan' | 'design' | 'develop' | 'test' | 'evaluate';
  status: 'completed' | 'skipped' | 'failed' | 'rolled-back' | 'pending-approval';
  intention?: Intention;
  planNoteRel?: string;
  designNoteRel?: string;
  retroNoteRel?: string;
  snapshotId?: string;
  error?: string;
  detail?: unknown;
}

export interface DevelopResult extends CycleResult {
  changes?: FileChange[];
  rejected?: Array<{ change: FileChange; reason: string }>;
  applied?: Array<{ path: string; action: string; ok: boolean; error?: string; snapshotId?: string }>;
  codegenSummary?: string;
  testRun?: { command: string; ok: boolean; code?: number; stderrTail?: string };
}

const INTENTIONS_FILE = path.join(PATHS.DATA_DIR, 'intentions.json');

function ensureIntentionsFile(): void {
  if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  if (!fs.existsSync(INTENTIONS_FILE)) fs.writeFileSync(INTENTIONS_FILE, '[]', 'utf8');
}

export function saveIntentions(items: Intention[]): void {
  ensureIntentionsFile();
  const all = readAllIntentions();
  const ids = new Set(items.map((i) => i.id));
  const merged = [...items, ...all.filter((i) => !ids.has(i.id))];
  fs.writeFileSync(INTENTIONS_FILE, JSON.stringify(merged, null, 2), 'utf8');
}

export function readAllIntentions(): Intention[] {
  ensureIntentionsFile();
  try {
    return JSON.parse(fs.readFileSync(INTENTIONS_FILE, 'utf8')) as Intention[];
  } catch {
    return [];
  }
}

export function readPendingIntentions(project?: string): Intention[] {
  return readAllIntentions()
    .filter((i) => !project || i.project === project)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function severityRank(s: Intention['severity']): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s] ?? 0;
}

/**
 * PDCAE 编排器：对一个项目的一个意向，跑一轮 Plan→Design→Develop→Test→Evaluate。
 * M3 阶段：**手动触发**（CLI 调），不自循环。
 */
export class PdcaeLoop {
  private log = getLogger('pdcae');
  readonly intentions: IntentionGenerator;

  private seedElevator: SeedElevator;

  constructor(
    public readonly router: Router,
    public readonly modePolicy: ModePolicy,
    public readonly currentMode: () => SupervisionMode,
    public readonly writer: VaultWriter,
    public readonly canRunTask: (est: number) => { ok: boolean; reason?: string }
  ) {
    this.intentions = new IntentionGenerator(router);
    this.seedElevator = new SeedElevator(router);
  }

  async plan(projectIdOrRel: string, hint?: string): Promise<CycleResult & { intentions: Intention[] }> {
    const project = findProject(projectIdOrRel);
    if (!project) {
      return this.failed('plan', `project not found: ${projectIdOrRel}`);
    }
    const gate = this.modePolicy.canPerform('plan' as any, this.currentMode());
    if (!gate.ok) {
      return this.failed('plan', gate.reason!);
    }
    const items = await this.intentions.generate(project, hint);
    if (items.length === 0) {
      return {
        project: project.id,
        phase: 'plan',
        status: 'skipped',
        intentions: [],
        detail: { reason: 'no intentions generated' },
      };
    }
    saveIntentions(items);
    const planBody = items
      .map(
        (i, idx) =>
          `### ${idx + 1}. [${i.severity}/${i.category}] ${i.title}\n\n- **为什么**：${i.rationale}\n- **怎么做**：${i.proposedAction}\n- **预估 token**：${i.estimatedTokens}\n- **风险**：${i.risks.join('；') || '(无)'}\n`
      )
      .join('\n');
    const note = this.writer.write({
      type: 'plan',
      project: project.id,
      title: `Plan - ${new Date().toISOString().slice(0, 10)} - ${items.length} 项`,
      tags: ['plan', project.id],
      body: `> 由 [[overSeer/knowledge/memory-judge|意向生成器]] 产出 ${items.length} 个候选。\n\n${planBody}`,
    });
    this.log.info({ project: project.id, count: items.length, note: note.note.relativePath }, 'plan done');
    return {
      project: project.id,
      phase: 'plan',
      status: 'completed',
      intentions: items,
      planNoteRel: note.note.relativePath.replace(/\.md$/, ''),
    };
  }

  /** M3：只跑 Plan + Evaluate；Develop/Test 需要明确 allowWrite 才会真改代码 */
  async executeIntention(intentionId: string): Promise<CycleResult> {
    const all = readAllIntentions();
    const intent = all.find((i) => i.id === intentionId);
    if (!intent) return this.failed('develop', `intention not found: ${intentionId}`);
    const project = findProject(intent.project);
    if (!project) return this.failed('develop', `project not found: ${intent.project}`);

    const budget = this.canRunTask(intent.estimatedTokens);
    if (!budget.ok) {
      return {
        project: project.id,
        phase: 'develop',
        status: 'skipped',
        intention: intent,
        error: budget.reason,
      };
    }

    const manifest = readManifest(project.rootAbs);
    if (!manifest.allowWrite) {
      this.log.warn(
        { project: project.id, intentionId },
        'project has allowWrite=false; producing design note only (no code changes)'
      );
      return this.designOnly(project, intent);
    }

    const designNote = this.writer.write({
      type: 'design',
      project: project.id,
      title: `Design - ${intent.title}`,
      tags: ['design', project.id, intent.category],
      body: this.renderDesignBody(intent),
    });

    this.log.warn(
      { project: project.id, intentionId },
      'M3: develop/test require explicit CLI command (`overseer intention <id> --develop`); auto-execute not enabled'
    );
    return {
      project: project.id,
      phase: 'design',
      status: 'completed',
      intention: intent,
      designNoteRel: designNote.note.relativePath.replace(/\.md$/, ''),
      detail: { hint: 'use CLI to explicitly run develop/test with --develop flag' },
    };
  }

  private async designOnly(project: ProjectInfo, intent: Intention): Promise<CycleResult> {
    const designNote = this.writer.write({
      type: 'design',
      project: project.id,
      title: `Design - ${intent.title}`,
      tags: ['design', project.id, intent.category],
      body: this.renderDesignBody(intent),
    });
    return {
      project: project.id,
      phase: 'design',
      status: 'completed',
      intention: intent,
      designNoteRel: designNote.note.relativePath.replace(/\.md$/, ''),
      detail: { reason: 'allowWrite=false; design only, no code changes' },
    };
  }

  private renderDesignBody(intent: Intention): string {
    return [
      `## 背景`,
      intent.rationale,
      '',
      `## 建议动作`,
      intent.proposedAction,
      '',
      `## 风险`,
      intent.risks.map((r) => `- ${r}`).join('\n') || '- (无)',
      '',
      `## 状态`,
      `M3 阶段：仅产出设计文档。若要执行需在该项目根目录创建 \`.overseer.json\` 并设 \`allowWrite=true\`，然后用 CLI 触发 develop 阶段。`,
    ].join('\n');
  }

  /** 显式触发 develop 阶段：调 LLM 产出代码改动 → 逐个写入（每文件前自动 snapshot）→ 可选跑测试 */
  async develop(intentionId: string, draftOnly = true): Promise<DevelopResult> {
    const all = readAllIntentions();
    const intent = all.find((i) => i.id === intentionId);
    if (!intent) return this.failed('develop', `intention not found: ${intentionId}`);
    const project = findProject(intent.project);
    if (!project) return this.failed('develop', `project not found: ${intent.project}`);

    if (draftOnly) {
      return this.designOnly(project, intent);
    }

    // 主控不可用 → 拒绝（degraded 永远不能写代码）
    const mode = this.currentMode();
    if (mode !== 'normal') {
      return {
        project: project.id,
        phase: 'develop',
        status: 'skipped',
        intention: intent,
        error: `mode=${mode}：写代码需要主控 provider（degraded/stopped 拒绝任何写动作）。配好主控 key 后再试。`,
      };
    }

    const manifest = readManifest(project.rootAbs);
    if (!manifest.allowWrite) {
      return {
        project: project.id,
        phase: 'develop',
        status: 'skipped',
        intention: intent,
        error: `project ${project.id} has allowWrite=false (改 .overseer.json 后重试)`,
      };
    }

    const executor = new ActionExecutor(project, this.modePolicy, this.currentMode);
    const codegen = new CodeChangeGenerator(this.router);

    this.log.info({ intentionId, project: project.id }, 'develop: calling codegen');
    const codegenRes = await codegen.generate(intent, project);

    if (codegenRes.changes.length === 0) {
      const evalNote = this.writeRetroNote(project, intent, {
        summary: codegenRes.summary,
        applied: [],
        rejected: codegenRes.rejected,
        testRun: undefined,
      });
      return {
        project: project.id,
        phase: 'develop',
        status: 'skipped',
        intention: intent,
        codegenSummary: codegenRes.summary,
        rejected: codegenRes.rejected,
        retroNoteRel: evalNote.note.relativePath.replace(/\.md$/, ''),
        detail: { reason: 'codegen produced 0 changes' },
      };
    }

    // 逐个写入（每文件前自动 snapshot）
    const applied: NonNullable<DevelopResult['applied']> = [];
    const writtenRels: string[] = [];
    for (const c of codegenRes.changes) {
      if (c.action === 'delete') {
        // delete 走 approvals（高危）
        const appr = approvals.create({
          project: project.id,
          action: 'file.delete',
          description: `delete ${c.path} (intention ${intent.id})`,
          context: { rationale: c.rationale },
        });
        applied.push({
          path: c.path,
          action: 'delete',
          ok: false,
          error: `pending approval ${appr.id}`,
        });
        continue;
      }
      const result = await executor.writeFile(c.path, c.content ?? '', {});
      applied.push({
        path: c.path,
        action: c.action,
        ok: result.ok,
        error: result.error,
        snapshotId: result.snapshot?.id,
      });
      if (result.ok) writtenRels.push(c.path);
    }

    // 可选跑测试
    let testRun: DevelopResult['testRun'];
    if (manifest.testCommand && writtenRels.length > 0) {
      const testResult = await executor.runShell(manifest.testCommand, { skipSnapshot: true });
      testRun = {
        command: manifest.testCommand,
        ok: testResult.ok,
        code: testResult.code,
        stderrTail: testResult.stderr?.split('\n').slice(-15).join('\n'),
      };
      if (!testResult.ok) {
        // 测试失败 → 自动回滚到第一个 snapshot
        const firstSnap = applied.find((a) => a.snapshotId)?.snapshotId;
        if (firstSnap) {
          this.log.warn({ snap: firstSnap }, 'test failed → auto rollback');
          await executor.rollbackTo(firstSnap);
          const note = this.writeRetroNote(project, intent, {
            summary: codegenRes.summary + '\n\n⚠ 测试失败，已自动回滚。',
            applied,
            rejected: codegenRes.rejected,
            testRun,
            rolledBackTo: firstSnap,
          });
          return {
            project: project.id,
            phase: 'evaluate',
            status: 'rolled-back',
            intention: intent,
            codegenSummary: codegenRes.summary,
            changes: codegenRes.changes,
            applied,
            rejected: codegenRes.rejected,
            testRun,
            snapshotId: firstSnap,
            retroNoteRel: note.note.relativePath.replace(/\.md$/, ''),
          };
        }
      }
    }

    const note = this.writeRetroNote(project, intent, {
      summary: codegenRes.summary,
      applied,
      rejected: codegenRes.rejected,
      testRun,
    });

    return {
      project: project.id,
      phase: 'evaluate',
      status: 'completed',
      intention: intent,
      codegenSummary: codegenRes.summary,
      changes: codegenRes.changes,
      applied,
      rejected: codegenRes.rejected,
      testRun,
      retroNoteRel: note.note.relativePath.replace(/\.md$/, ''),
    };
  }

  private writeRetroNote(
    project: ProjectInfo,
    intent: Intention,
    data: {
      summary: string;
      applied: NonNullable<DevelopResult['applied']>;
      rejected: Array<{ change: FileChange; reason: string }>;
      testRun?: DevelopResult['testRun'];
      rolledBackTo?: string;
    }
  ) {
    const lines: string[] = [];
    lines.push(`## 意向`, `- id: ${intent.id}`, `- title: ${intent.title}`, '');
    lines.push(`## codegen summary`, data.summary, '');
    if (data.applied.length > 0) {
      lines.push(`## 应用情况`);
      for (const a of data.applied) {
        const flag = a.ok ? '✓' : '✗';
        lines.push(`- ${flag} \`${a.action}\` ${a.path}${a.snapshotId ? ` (snap ${a.snapshotId})` : ''}${a.error ? ` — ${a.error}` : ''}`);
      }
      lines.push('');
    }
    if (data.rejected.length > 0) {
      lines.push(`## 被拒改动`);
      for (const r of data.rejected) {
        lines.push(`- ${r.change.path} (${r.change.action}) — ${r.reason}`);
      }
      lines.push('');
    }
    if (data.testRun) {
      lines.push(`## 测试`);
      lines.push(`- 命令：\`${data.testRun.command}\``);
      lines.push(`- 结果：${data.testRun.ok ? '✓ pass' : `✗ fail (exit ${data.testRun.code})`}`);
      if (data.testRun.stderrTail) lines.push('', '```', data.testRun.stderrTail, '```');
      lines.push('');
    }
    if (data.rolledBackTo) {
      lines.push(`## ⚠ 自动回滚`, `已撤回到 snapshot \`${data.rolledBackTo}\`。`, '');
    }
    return this.writer.write({
      type: 'retro',
      project: project.id,
      title: `Retro - ${intent.title}`,
      tags: ['retro', project.id, intent.category, 'self-improve'],
      body: lines.join('\n'),
    });
  }

  private failed(phase: CycleResult['phase'], error: string): any {
    this.log.error({ phase, err: error }, 'cycle failed');
    return {
      project: '?',
      phase,
      status: 'failed',
      error,
    };
  }

  /**
   * 直接处理一个 queue item（TaskLoop 用）：
   * 1. 把 queue item 懒合成成 Intention 写入 intentions.json
   * 2. 根据 manifest.allowWrite 决定真改代码（develop--execute）还是只 design
   */
  async executeQueueItem(item: QueueItem): Promise<DevelopResult> {
    const intentId = 'q-' + item.id;

    // 1. 懒合成 Intention（如果还没有）
    const all = readAllIntentions();
    if (!all.find((i) => i.id === intentId)) {
      const seed: IntentionSeed = {
        key: item.dedupe,
        project: item.project,
        source: item.source,
        category: item.category,
        severity: item.severity,
        title: item.title,
        detail: item.detail,
        hint: item.hint,
        files: item.files,
        detectedAt: item.firstSeen,
      };
      const intent = await this.seedElevator.elevate(seed);
      // 用 q-id 覆盖生成的 id，保持与 queue 关联
      intent.id = intentId;
      all.push(intent);
      fs.writeFileSync(path.join(PATHS.DATA_DIR, 'intentions.json'), JSON.stringify(all, null, 2), 'utf8');
    }

    // 2. 预算闸门：在干活前先检查是否负担得起
    const estimatedTokens = this.estimateForQueueItem(item);
    const budgetCheck = this.canRunTask(estimatedTokens);
    if (!budgetCheck.ok) {
      return {
        project: item.project,
        phase: 'plan',
        status: 'skipped',
        error: budgetCheck.reason,
        detail: { estimatedTokens },
      };
    }

    // 3. 检查项目是否真allowWrite
    const project = findProject(item.project);
    if (!project) {
      return this.failed('develop', `project not found: ${item.project}`);
    }
    const manifest = readManifest(project.rootAbs);
    // draftOnly=true → 只 design；draftOnly=false → 真改代码
    return this.develop(intentId, !manifest.allowWrite);
  }

  private estimateForQueueItem(item: QueueItem): number {
    // design-only 比 develop 便宜很多
    const project = findProject(item.project);
    const manifest = project ? readManifest(project.rootAbs) : null;
    const base = manifest?.allowWrite ? 30_000 : 6_000;
    const files = item.files?.length ?? 0;
    return base + files * 1_200;
  }
}
