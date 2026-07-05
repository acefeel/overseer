import { extractJsonObject } from '../util/json.js';
import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';
import type { ProjectInfo } from '../projects/scanner.js';
import { gatherProjectContext } from './plan.js';
import type { IntentionSeed } from '../scanners/base.js';

export interface MilestoneReview {
  reached: boolean;
  reason: string;
  suggestions: IntentionSeed[];
}

const REVIEW_SYSTEM_PROMPT = `你是 overSeer 的"远程顾问"（consultant）。本地 worker 刚跑完所有 queued 任务，请你判断项目是否到达 milestone，或者还有改进空间。

## 判定原则

**reached=true（确实到 milestone）**：
- 当前状态在合理范围内可接受
- 没有明显 bug / 技术债 / 测试缺失 / 安全问题
- 用户期望的核心功能已实现

**reached=false（还有事做）**：
- 列出**具体的、可执行的**改进建议（不是泛泛而谈）
- 每条建议要有：标题、严重度、理由、建议动作

## 输出

严格 JSON（不要 markdown 代码块）：
{
  "reached": true | false,
  "reason": "判定理由（中文，1-2 句）",
  "suggestions": [
    {
      "key": "unique-key",
      "category": "bug|tech-debt|feature|test|docs|refactor|security|perf|hygiene",
      "severity": "low|medium|high|critical",
      "title": "简短标题（中英混排）",
      "detail": "为什么 + 是什么（2-4 句）",
      "hint": "建议怎么动手（具体到文件/命令）",
      "files": ["相关文件路径"]
    }
  ]
}

注意：suggestions 应该是 worker 能直接执行的级别，不是模糊的方向。`;

const ESCALATION_SYSTEM_PROMPT = `你是 overSeer 的远程顾问。本地 worker 报告它在执行某个任务时被卡住（block）了。请你给出**具体的、可立即应用的**解决方案。

## 输出

严格 JSON：
{
  "resolved": true | false,
  "approach": "具体方案（中文，3-8 句）。如果 worker 能根据这个描述自己实现，给完整步骤。如果必须你（consultant）直接代写，明确说 'consultant-must-take-over'。",
  "codeHint": "可选：直接给一段代码/diff 示例（worker 可以参考）",
  "needsConsultantOverride": true | false
}

如果连你也搞不定，resolved=false 并解释为什么。`;

export class Consultant {
  private log = getLogger('consultant');
  constructor(public readonly router: Router) {}

  /** 项目是否到了 milestone？没到则给出新的改进建议 */
  async reviewProject(project: ProjectInfo): Promise<MilestoneReview> {
    if (!this.router.hasConsultant()) {
      return {
        reached: false,
        reason: 'no consultant available, cannot verify milestone',
        suggestions: [],
      };
    }
    const ctx = await gatherProjectContext(project);
    const userPrompt = [
      ctx,
      '',
      '## 当前状态',
      `时间：${new Date().toISOString()}`,
      '本地 worker 已跑完所有 queued 任务。请判断 milestone。',
      '',
      '## 输出',
      '严格 JSON。',
    ].join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    try {
      const res = await this.router.chatViaConsultant({
        messages,
        task: 'planning',
        temperature: 0.3,
        maxTokens: 3000,
      });
      this.log.info(
        { project: project.id, in: res.usage.promptTokens, out: res.usage.completionTokens },
        'consultant review done'
      );
      return this.parseReview(res.text, project.id);
    } catch (e) {
      this.log.warn({ err: String(e) }, 'consultant review failed');
      return {
        reached: false,
        reason: `consultant call failed: ${(e as Error).message}`,
        suggestions: [],
      };
    }
  }

  /** worker 卡住时向 consultant 求助。返回的方案如果 needsConsultantOverride=true，调用方应直接调 consultant 代写 */
  async escalate(
    project: ProjectInfo,
    task: { title: string; rationale: string; proposedAction: string },
    blockReason: string,
    context?: string
  ): Promise<{
    resolved: boolean;
    approach: string;
    codeHint?: string;
    needsConsultantOverride: boolean;
  }> {
    if (!this.router.hasConsultant()) {
      return {
        resolved: false,
        approach: `cannot escalate (no consultant): ${blockReason}`,
        needsConsultantOverride: false,
      };
    }
    const userPrompt = [
      `## 项目：${project.id}`,
      '',
      `## 任务`,
      `- 标题：${task.title}`,
      `- 为什么：${task.rationale}`,
      `- 建议动作：${task.proposedAction}`,
      '',
      `## Worker 报告的卡点`,
      blockReason,
      '',
      context ? `## 上下文\n${context}` : '',
      '',
      '## 你的方案',
      '严格 JSON。',
    ].join('\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: ESCALATION_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    try {
      const res = await this.router.chatViaConsultant({
        messages,
        task: 'planning',
        temperature: 0.3,
        maxTokens: 2500,
      });
      return this.parseEscalation(res.text);
    } catch (e) {
      this.log.warn({ err: String(e) }, 'escalation failed');
      return {
        resolved: false,
        approach: `escalation error: ${(e as Error).message}`,
        needsConsultantOverride: false,
      };
    }
  }

  private parseReview(text: string, projectId: string): MilestoneReview {
    const obj = extractJsonObject(text);
    if (!obj) {
      return { reached: false, reason: 'invalid JSON from consultant', suggestions: [] };
    }
    const now = new Date().toISOString();
    const suggestions: IntentionSeed[] = Array.isArray(obj.suggestions)
      ? obj.suggestions.map((s: any) => ({
          key: String(s.key ?? `consultant-${Math.random().toString(36).slice(2, 8)}`),
          project: projectId,
          source: 'llm-plan' as const,
          category: s.category ?? 'tech-debt',
          severity: s.severity ?? 'medium',
          title: String(s.title ?? 'consultant suggestion'),
          detail: String(s.detail ?? ''),
          hint: s.hint ? String(s.hint) : undefined,
          files: Array.isArray(s.files) ? s.files.map(String) : undefined,
          detectedAt: now,
        }))
      : [];
    return {
      reached: obj.reached === true,
      reason: String(obj.reason ?? '(no reason)'),
      suggestions,
    };
  }

  private parseEscalation(text: string): {
    resolved: boolean;
    approach: string;
    codeHint?: string;
    needsConsultantOverride: boolean;
  } {
    const obj = extractJsonObject(text);
    if (!obj) {
      return { resolved: false, approach: 'invalid JSON', needsConsultantOverride: false };
    }
    return {
      resolved: obj.resolved === true,
      approach: String(obj.approach ?? ''),
      codeHint: obj.codeHint as string | undefined,
      needsConsultantOverride: obj.needsConsultantOverride === true,
    };
  }
}
