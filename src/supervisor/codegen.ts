import fs from 'node:fs';
import path from 'node:path';
import { extractJsonObject } from '../util/json.js';
import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';
import type { ProjectInfo } from '../projects/scanner.js';
import { readManifest } from '../projects/manifest.js';
import { isProtected } from '../util/glob.js';
import type { Intention } from './plan.js';

export type FileAction = 'create' | 'modify' | 'delete';

export interface FileChange {
  path: string;            // 相对 project root
  action: FileAction;
  content?: string;        // create/modify 必填
  rationale: string;       // 为什么改这个文件（中文，1-2 句）
}

export interface CodeGenResult {
  changes: FileChange[];
  summary: string;         // 本次改动的总体说明
  rejected: Array<{ change: FileChange; reason: string }>;
}

const SYSTEM_PROMPT = `你是 overSeer 的代码生成器。给定一个改进意向、设计笔记、相关源码片段，请产出**最小、聚焦、可直接应用**的代码改动。

## 输出格式

严格 JSON（不要 markdown 代码块），结构：
{
  "summary": "本次改动的总体说明（中文，2-3 句）",
  "changes": [
    {
      "path": "相对项目根的路径（POSIX 风格，如 src/foo.ts）",
      "action": "create" | "modify" | "delete",
      "content": "完整的新文件内容（create/modify 必填；delete 省略）",
      "rationale": "为什么这么改（中文，1-2 句）"
    }
  ]
}

## 硬约束

1. **小步快跑**：单次最多改 5 个文件，总改动 < 30KB。超过请明确说"需要拆分"并只做最关键部分。
2. **聚焦意图**：只改与给定 intention 直接相关的内容；不顺手"清理"无关代码。
3. **完整文件**：modify 时输出整文件新内容（不是 diff），便于直接写入。
4. **不碰保护路径**：config/ / .secrets.* / data/ / vault/ / dist/ / package-lock.json 等。如果非改不可，在 summary 里说明，但 changes 里不出现。
5. **保留可编译**：TypeScript 改动必须能通过 typecheck。不要破坏 import / export。
6. **保守删文件**：delete 仅在 intention 明确要求"清理废弃文件"时使用。
7. **诚实**：如果信息不足以产出可应用改动，返回 \`{ "summary": "...", "changes": [] }\` 并在 summary 里说明缺什么。`;

const MAX_FILE_BYTES = 12_000;     // 单个文件读进上下文的截断
const MAX_CONTEXT_FILES = 8;
const MAX_TOTAL_CHANGES = 5;
const MAX_TOTAL_BYTES = 30_000;

export class CodeChangeGenerator {
  private log = getLogger('codegen');

  constructor(public readonly router: Router) {}

  async generate(
    intent: Intention,
    project: ProjectInfo,
    opts: { designBody?: string } = {}
  ): Promise<CodeGenResult> {
    const manifest = readManifest(project.rootAbs);
    const ctx = await this.gatherContext(intent, project);

    const userBlocks: string[] = [
      `## 项目：${project.id} (${project.relPath})`,
      '',
      `## 改进意向`,
      `- 标题：${intent.title}`,
      `- 严重度：${intent.severity}`,
      `- 类别：${intent.category}`,
      `- rationale：${intent.rationale}`,
      `- 建议动作：${intent.proposedAction}`,
      `- 风险：${intent.risks.join('；') || '(无)'}`,
    ];
    if (opts.designBody) {
      userBlocks.push('', `## 设计笔记`, opts.designBody);
    }
    if (ctx.files.length > 0) {
      userBlocks.push('', `## 相关源码片段（可能截断）`);
      for (const f of ctx.files) {
        userBlocks.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
      }
    }
    userBlocks.push(
      '',
      `## 受保护路径（不要碰）`,
      manifest.protectedPaths.map((p) => `- \`${p}\``).join('\n'),
      '',
      '## 你的输出',
      '严格 JSON，遵循硬约束。聚焦最小可应用改动。'
    );

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userBlocks.join('\n') },
    ];

    let raw: string;
    try {
      const res = await this.router.chat({
        messages,
        task: 'planning',
        temperature: 0.2,
        maxTokens: 6000,
      });
      raw = res.text;
    } catch (e) {
      this.log.warn({ err: String(e) }, 'codegen LLM call failed');
      return {
        changes: [],
        summary: `LLM 调用失败：${(e as Error).message}`,
        rejected: [],
      };
    }

    return this.parseAndFilter(raw, manifest.protectedPaths);
  }

  private async gatherContext(
    intent: Intention,
    project: ProjectInfo
  ): Promise<{ files: Array<{ path: string; content: string }> }> {
    const candidates = intent.files && intent.files.length > 0
      ? intent.files.slice(0, MAX_CONTEXT_FILES)
      : this.heuristicFiles(project);

    const out: Array<{ path: string; content: string }> = [];
    for (const rel of candidates) {
      const abs = path.join(project.rootAbs, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      try {
        const txt = fs.readFileSync(abs, 'utf8');
        out.push({
          path: rel,
          content: txt.length > MAX_FILE_BYTES
            ? txt.slice(0, MAX_FILE_BYTES) + '\n\n/* … truncated … */'
            : txt,
        });
      } catch {
        /* skip */
      }
    }
    return { files: out };
  }

  private heuristicFiles(project: ProjectInfo): string[] {
    const out: string[] = [];
    const srcDir = path.join(project.rootAbs, 'src');
    if (fs.existsSync(srcDir)) {
      this.walkTs(srcDir, project.rootAbs, out, 20);
    }
    if (fs.existsSync(path.join(project.rootAbs, 'AGENTS.md'))) {
      out.push('AGENTS.md');
    }
    if (fs.existsSync(path.join(project.rootAbs, 'README.md'))) {
      out.push('README.md');
    }
    return out.slice(0, MAX_CONTEXT_FILES);
  }

  private walkTs(dir: string, root: string, out: string[], cap: number): void {
    if (out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
        this.walkTs(full, root, out, cap);
      } else if (e.isFile() && /\.(ts|js|md)$/.test(e.name)) {
        out.push(path.relative(root, full).replace(/\\/g, '/'));
      }
    }
  }

  private parseAndFilter(raw: string, protectedPatterns: string[]): CodeGenResult {
    const parsed = extractJsonObject(raw);
    if (!parsed) {
      return { changes: [], summary: 'LLM 未返回 JSON', rejected: [] };
    }

    const all = Array.isArray(parsed.changes) ? parsed.changes : [];
    const accepted: FileChange[] = [];
    const rejected: CodeGenResult['rejected'] = [];
    let totalBytes = 0;

    for (const c of all) {
      if (accepted.length >= MAX_TOTAL_CHANGES) {
        rejected.push({ change: c, reason: '超过单次最大文件数 (5)' });
        continue;
      }
      if (!c.path || typeof c.path !== 'string') {
        rejected.push({ change: c, reason: '缺少 path' });
        continue;
      }
      const rel = c.path.replace(/\\/g, '/').replace(/^\.?\//, '');
      if (isProtected(rel, protectedPatterns)) {
        rejected.push({ change: c, reason: `命中受保护路径 (${rel})` });
        continue;
      }
      const contentBytes = c.content ? Buffer.byteLength(c.content, 'utf8') : 0;
      if (totalBytes + contentBytes > MAX_TOTAL_BYTES) {
        rejected.push({ change: c, reason: '超过单次最大字节预算 (30KB)' });
        continue;
      }
      totalBytes += contentBytes;
      accepted.push({
        path: rel,
        action: c.action === 'delete' ? 'delete' : c.action === 'create' ? 'create' : 'modify',
        content: c.content,
        rationale: c.rationale || '(无)',
      });
    }

    this.log.info(
      { accepted: accepted.length, rejected: rejected.length, bytes: totalBytes },
      'codegen parsed'
    );
    return {
      changes: accepted,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '(无 summary)',
      rejected,
    };
  }
}
