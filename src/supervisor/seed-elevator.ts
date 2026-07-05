import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';
import { extractJsonObject } from '../util/json.js';
import type { IntentionSeed } from '../scanners/base.js';
import type { Intention } from './plan.js';

const SYSTEM_PROMPT = `你是 overSeer 的"意向升华器"。给定一个由扫描器发现的原始问题种子，请把它升级为结构化的开发意向。

输入种子字段：
- project: 项目 id
- source: 来源（todo / git / outdated / test / lint）
- category: 类别
- severity: 严重度
- title: 标题
- detail: 细节
- hint?: 建议动作
- files?: 相关文件

输出严格 JSON：
{
  "rationale": "为什么这个种子值得处理（中文，2-4 句）",
  "proposedAction": "具体建议怎么做（文件/命令/步骤）",
  "estimatedTokens": 8000,
  "risks": ["风险1", "风险2"]
}

约束：
- estimatedTokens 按任务大小给整数：仅 design=4000~8000，小改动=15000~25000，重构=30000~60000
- risks 要诚实，含"可能误判"的概率
- 输出只含 JSON，不要解释`;

export class SeedElevator {
  private log = getLogger('seed-elevator');
  constructor(public readonly router: Router) {}

  async elevate(seed: IntentionSeed): Promise<Intention> {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: this.buildPrompt(seed) },
    ];

    try {
      const res = await this.router.chatViaWorker({
        messages,
        task: 'summary',
        temperature: 0.3,
        maxTokens: 1200,
      });
      const parsed = extractJsonObject(res.text);
      if (!parsed || typeof parsed.rationale !== 'string') {
        this.log.warn({ raw: res.text.slice(0, 200) }, 'seed elevator returned non-JSON');
        return this.fallback(seed);
      }
      return {
        id: 'int-' + Math.random().toString(36).slice(2, 9),
        title: seed.title,
        project: seed.project,
        category: seed.category,
        severity: seed.severity,
        rationale: String(parsed.rationale),
        proposedAction: String(parsed.proposedAction ?? seed.hint ?? '(no hint)'),
        estimatedTokens: Number(parsed.estimatedTokens) || this.defaultEstimate(seed),
        risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : ['可能误判，请人工确认'],
        source: 'scan',
        createdAt: new Date().toISOString(),
        files: seed.files,
      };
    } catch (e) {
      this.log.warn({ err: String(e) }, 'seed elevator failed');
      return this.fallback(seed);
    }
  }

  async elevateBatch(seeds: IntentionSeed[]): Promise<Intention[]> {
    const out: Intention[] = [];
    for (const seed of seeds) {
      out.push(await this.elevate(seed));
    }
    return out;
  }

  private buildPrompt(seed: IntentionSeed): string {
    return [
      `## 原始种子`,
      `- project: ${seed.project}`,
      `- source: ${seed.source}`,
      `- category: ${seed.category}`,
      `- severity: ${seed.severity}`,
      `- title: ${seed.title}`,
      `- detail: ${seed.detail}`,
      seed.hint ? `- hint: ${seed.hint}` : '',
      seed.files ? `- files: ${seed.files.join(', ')}` : '',
      '',
      '## 输出',
      '严格 JSON。',
    ].join('\n');
  }

  private fallback(seed: IntentionSeed): Intention {
    return {
      id: 'int-' + Math.random().toString(36).slice(2, 9),
      title: seed.title,
      project: seed.project,
      category: seed.category,
      severity: seed.severity,
      rationale: seed.detail,
      proposedAction: seed.hint ?? '请人工确认后再处理',
      estimatedTokens: this.defaultEstimate(seed),
      risks: ['扫描器自动生成，可能误判'],
      source: 'scan',
      createdAt: new Date().toISOString(),
      files: seed.files,
    };
  }

  private defaultEstimate(seed: IntentionSeed): number {
    switch (seed.source) {
      case 'todo':
        return seed.severity === 'high' ? 12_000 : 6_000;
      case 'git':
        return 4_000;
      case 'outdated':
        return 10_000;
      case 'test':
        return 20_000;
      case 'lint':
        return 8_000;
      default:
        return 6_000;
    }
  }
}
