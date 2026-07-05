import { extractJsonObject } from '../util/json.js';
import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';

export interface JudgeInput {
  userText: string;
  assistantText: string;
  recentContext?: string;
}

export interface JudgeDecision {
  shouldWrite: boolean;
  reason: string;
  note?: {
    type:
      | 'adr'
      | 'knowledge'
      | 'plan'
      | 'design'
      | 'retro'
      | 'budget';
    title: string;
    project: string;
    tags: string[];
    body: string;
    /** 是否同时往当日 daily 写一条索引 */
    dailyMention?: boolean;
  };
}

const SYSTEM_PROMPT = `你是 overSeer 的"信息价值判断器"。你的唯一职责：判断当前这一轮对话里，是否出现了"如果丢失会误导后续决策"的关键信息。

判定标准（命中任一即应写）：
- 架构/选型/技术决策（ADR）：选了 X 而不选 Y、为什么
- 项目结构/约束/边界：哪个模块在哪个目录、不能改什么、为什么
- 协议/接口/数据契约：字段含义、格式、约束
- 业务规则/优先级/模式：先做 A 再做 B、什么情况触发什么动作
- 教训/陷阱/坑：踩过什么坑、什么操作会有副作用
- 用户偏好/工作方式：用户希望怎么沟通、用什么风格

不该写的：
- 闲聊、问候
- 一次性问答（怎么用某个命令）
- 已存在于 vault 的内容（除非有重要修正）
- 模糊、未拍板的讨论

输出**严格 JSON**（不要 markdown 代码块、不要解释），格式：
{
  "shouldWrite": true|false,
  "reason": "简短理由（中文，<60字）",
  "note": {
    "type": "adr|knowledge|plan|design|retro|budget",
    "title": "简洁标题（中英混排）",
    "project": "overSeer|aaws|JHAVSP|<其他>",
    "tags": ["tag1","tag2"],
    "body": "markdown 正文，3-12 行，要包含『为什么』『是什么』『影响』；可用 wikilink [[...]] 引用其他笔记",
    "dailyMention": true|false
  }
}

若 shouldWrite=false，note 可省略。`;

export class MemoryJudge {
  private log = getLogger('kb:judge');
  constructor(public readonly router: Router) {}

  async evaluate(input: JudgeInput): Promise<JudgeDecision> {
    if (this.isTrivial(input)) {
      return { shouldWrite: false, reason: 'trivial message, skip judge call' };
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: this.buildUserPrompt(input),
      },
    ];
    try {
      const res = await this.router.chat({
        messages,
        task: 'summary',
        temperature: 0.1,
        maxTokens: 800,
      });
      const parsed = this.parseJson(res.text);
      if (!parsed) {
        this.log.warn({ raw: res.text.slice(0, 200) }, 'judge returned non-JSON');
        return { shouldWrite: false, reason: 'judge output unparseable' };
      }
      return parsed;
    } catch (e) {
      this.log.warn({ err: String(e) }, 'judge call failed');
      return { shouldWrite: false, reason: `judge error: ${(e as Error).message}` };
    }
  }

  private isTrivial(input: JudgeInput): boolean {
    const u = input.userText.trim();
    const a = input.assistantText.trim();
    if (u.length < 8 && a.length < 60) return true;
    if (/^(hi|hello|你好|在吗|嗨|test|ping)\??$/i.test(u)) return true;
    return false;
  }

  private buildUserPrompt(input: JudgeInput): string {
    const parts: string[] = [];
    if (input.recentContext) {
      parts.push(`## 已存在的相关记忆\n\n${input.recentContext}`);
    }
    parts.push(`## 本轮对话\n\n**user:**\n${input.userText}\n\n**overSeer:**\n${input.assistantText}`);
    parts.push(`## 你的判断\n\n输出 JSON。`);
    return parts.join('\n\n');
  }

  private parseJson(text: string): JudgeDecision | null {
    const obj = extractJsonObject(text);
    if (!obj || typeof obj.shouldWrite !== 'boolean') return null;
    if (obj.shouldWrite && !obj.note) return null;
    return obj as unknown as JudgeDecision;
  }
}
