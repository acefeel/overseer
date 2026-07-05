import { VaultWriter, type WriteResult } from './writer.js';
import type { NoteType } from './schema.js';

export interface EventNoteInput {
  /** 笔记类型 */
  type: NoteType;
  /** 项目名 */
  project: string;
  /** 标题 */
  title: string;
  /** 标签 */
  tags?: string[];
  /** 正文 */
  body: string;
  /** 是否同时追加到 daily */
  dailyMention?: boolean | { section: string };
}

/**
 * 把运行时事件沉淀为 Vault 笔记。
 * 所有“自动写入”统一走这里，便于后续做采样、去重、审计。
 */
export class VaultRecorder {
  constructor(public readonly writer: VaultWriter) {}

  record(opts: EventNoteInput): WriteResult {
    try {
      const result = this.writer.write({
        type: opts.type,
        project: opts.project,
        title: opts.title,
        tags: opts.tags ?? ['event', opts.project],
        body: opts.body,
      });

      if (opts.dailyMention) {
        const section = typeof opts.dailyMention === 'object' ? opts.dailyMention.section : opts.title;
        this.writer.appendDaily(
          section,
          `type=${opts.type} · project=${opts.project}\n\n[[${result.note.relativePath.replace(/\.md$/, '')}]]\n\n${opts.body.split('\n').slice(0, 3).join('\n')}`
        );
      }

      return result;
    } catch (e) {
      return { note: {} as any, created: false };
    }
  }

  budgetEvent(level: string, snapshot: unknown, reason?: string): WriteResult {
    return this.record({
      type: 'budget',
      project: 'overSeer',
      title: `budget ${level} - ${new Date().toISOString().slice(0, 10)}`,
      tags: ['budget', 'event', level],
      body: [
        `## 触发条件`,
        `- 时间：${new Date().toISOString()}`,
        `- 等级：${level}`,
        reason ? `- 原因：${reason}` : '',
        '',
        `## 快照`,
        '```json',
        JSON.stringify(snapshot, null, 2),
        '```',
      ].join('\n'),
      dailyMention: { section: `预算事件 - ${level}` },
    });
  }

  providerEvent(
    providerId: string,
    event: 'failover' | 'recovered' | 'unreachable',
    detail: unknown
  ): WriteResult {
    return this.record({
      type: 'knowledge',
      project: 'overSeer',
      title: `provider ${providerId} ${event}`,
      tags: ['provider', event, providerId],
      body: [
        `## 事件`,
        `- provider: ${providerId}`,
        `- event: ${event}`,
        `- 时间：${new Date().toISOString()}`,
        '',
        `## 详情`,
        '```json',
        JSON.stringify(detail, null, 2),
        '```',
      ].join('\n'),
      dailyMention: { section: `provider ${event} - ${providerId}` },
    });
  }

  actionEvent(
    project: string,
    action: string,
    outcome: { ok: boolean; error?: string; detail?: unknown }
  ): WriteResult {
    return this.record({
      type: 'retro',
      project,
      title: `Action ${outcome.ok ? '✓' : '✗'} - ${action}`,
      tags: ['action', outcome.ok ? 'success' : 'failure', project],
      body: [
        `## 动作`,
        `- 项目：${project}`,
        `- 动作：${action}`,
        `- 结果：${outcome.ok ? '成功' : '失败'}`,
        `- 时间：${new Date().toISOString()}`,
        '',
        outcome.error ? `## 错误\n\n${outcome.error}\n` : '',
        outcome.detail ? `## 详情\n\n\`\`\`json\n${JSON.stringify(outcome.detail, null, 2)}\n\`\`\`` : '',
      ].join('\n'),
    });
  }

  queueEvent(
    project: string,
    event: 'added' | 'executed' | 'dropped' | 'escalated',
    detail: { id?: string; title?: string; reason?: string }
  ): WriteResult {
    return this.record({
      type: 'knowledge',
      project,
      title: `queue ${event}${detail.title ? ' - ' + detail.title.slice(0, 40) : ''}`,
      tags: ['queue', event, project],
      body: [
        `## 队列事件`,
        `- 项目：${project}`,
        `- 事件：${event}`,
        detail.id ? `- id：${detail.id}` : '',
        detail.title ? `- 标题：${detail.title}` : '',
        detail.reason ? `- 原因：${detail.reason}` : '',
        `- 时间：${new Date().toISOString()}`,
      ].join('\n'),
    });
  }
}
