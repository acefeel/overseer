import fs from 'node:fs';
import path from 'node:path';
import { extractJsonArray } from '../util/json.js';
import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatMessage } from '../providers/base.js';
import type { ProjectInfo } from '../projects/scanner.js';
import { readManifest } from '../projects/manifest.js';
import { ProjectGit } from '../vcs/git.js';

export interface Intention {
  id: string;
  title: string;
  project: string;
  category: 'bug' | 'tech-debt' | 'feature' | 'test' | 'docs' | 'refactor' | 'security' | 'perf' | 'hygiene';
  severity: 'low' | 'medium' | 'high' | 'critical';
  rationale: string;
  proposedAction: string;
  estimatedTokens: number;
  risks: string[];
  source: 'llm' | 'scan' | 'user' | 'manual';
  createdAt: string;
  /** 关联文件（用于 codegen 上下文）；可能为空 */
  files?: string[];
}

const SYSTEM_PROMPT = `你是 overSeer 的"项目意向生成器"。给定项目目录结构、近期 git 改动、配置和已知上下文，请输出若干"还应该改进的事"——可以理解为 backlog 候选项。

输出**严格 JSON 数组**（不要 markdown 代码块），每项格式：
{
  "title": "简短标题（中英混排，<40字）",
  "category": "bug|tech-debt|feature|test|docs|refactor|security|perf",
  "severity": "low|medium|high|critical",
  "rationale": "为什么需要做（中文，2-4 句）",
  "proposedAction": "建议怎么动手（具体到文件/命令/步骤）",
  "estimatedTokens": <估算需要的 LLM token，整数>,
  "risks": ["风险1","风险2"]
}

判定原则：
- 只列**真正应该做**的；不列已经很好的。
- 优先技术债、潜在 bug、缺失的测试、安全/性能隐患、文档与代码不一致。
- risks 要诚实，含"可能误判"的概率。
- 若信息不足，宁可少列。`;

export async function gatherProjectContext(project: ProjectInfo): Promise<string> {
  const parts: string[] = [];
  const root = project.rootAbs;

  parts.push(`## 项目：${project.id}  (${project.relPath})`);
  parts.push(`- detectedBy: ${project.detectedBy.join(', ')}`);
  parts.push(`- isGitRepo: ${project.isGitRepo}`);

  try {
    const manifest = readManifest(root);
    parts.push(
      `- manifest: allowWrite=${manifest.allowWrite}, mainBranch=${manifest.mainBranch}, testCommand="${manifest.testCommand}", allowExec=${JSON.stringify(manifest.allowExec)}`
    );
  } catch {
    /* ignore */
  }

  if (project.isGitRepo) {
    try {
      const git = new ProjectGit(root);
      const status = await git.status();
      parts.push(
        `\n## git 状态\n- branch: ${status.currentBranch ?? '(detached)'}\n- dirty: ${status.dirty} (modified=${status.modified}, untracked=${status.untracked}, staged=${status.staged})\n- ahead/behind: ${status.ahead}/${status.behind}`
      );
      const log = await git.raw(['log', '--oneline', '-15']);
      parts.push(`\n## 近 15 次提交\n\`\`\`\n${log.trim()}\n\`\`\``);
      const diffStat = await git.raw(['diff', '--stat', 'HEAD~5..HEAD']).catch(() => '');
      if (diffStat.trim()) {
        parts.push(`\n## 近 5 次提交 diff 统计\n\`\`\`\n${diffStat.trim()}\n\`\`\``);
      }
    } catch (e) {
      parts.push(`\n(git inspection failed: ${(e as Error).message})`);
    }
  }

  try {
    const top = scanTopLevel(root);
    if (top) parts.push(`\n## 顶层结构\n\`\`\`\n${top}\n\`\`\``);
  } catch {
    /* ignore */
  }

  for (const f of ['AGENTS.md', 'README.md', 'package.json']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8').slice(0, 2000);
      parts.push(`\n## ${f}（截断到 2000 字符）\n${txt}`);
    }
  }

  return parts.join('\n');
}

function scanTopLevel(root: string): string {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const lines: string[] = [];
  for (const e of entries.slice(0, 40)) {
    if (e.name.startsWith('.') && e.name !== '.git') continue;
    if (['node_modules', 'dist', 'vendor', 'build'].includes(e.name)) continue;
    lines.push(e.isDirectory() ? `${e.name}/` : e.name);
  }
  return lines.join('\n');
}

export class IntentionGenerator {
  private log = getLogger('intentions');

  constructor(public readonly router: Router) {}

  async generate(project: ProjectInfo, hint?: string): Promise<Intention[]> {
    const ctx = await gatherProjectContext(project);
    const userBlocks: string[] = [ctx];
    if (hint) userBlocks.push(`## 用户提示\n${hint}`);
    userBlocks.push('## 你的输出\n返回严格 JSON 数组（即使为空也要返回 []）。');

    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userBlocks.join('\n\n') },
    ];

    try {
      const res = await this.router.chat({
        messages,
        task: 'planning',
        temperature: 0.4,
        maxTokens: 3000,
      });
      const parsed = this.parseIntentions(res.text, project.id);
      this.log.info({ project: project.id, count: parsed.length }, 'intentions generated');
      return parsed;
    } catch (e) {
      this.log.warn({ err: String(e) }, 'intention generation failed');
      return [];
    }
  }

  private parseIntentions(text: string, projectId: string): Intention[] {
    const arr = extractJsonArray(text);
    if (!arr) return [];
    const out: Intention[] = [];
    for (const item of arr) {
      const it = item as Record<string, unknown>;
      if (!it || typeof it !== 'object') continue;
      out.push({
        id: 'int-' + Math.random().toString(36).slice(2, 9),
        title: String(it.title ?? 'untitled'),
        project: projectId,
        category: (it.category as Intention['category']) ?? 'tech-debt',
        severity: (it.severity as Intention['severity']) ?? 'medium',
        rationale: String(it.rationale ?? ''),
        proposedAction: String(it.proposedAction ?? ''),
        estimatedTokens: Number(it.estimatedTokens ?? 50000) || 50000,
        risks: Array.isArray(it.risks) ? it.risks.map(String) : [],
        source: 'llm',
        createdAt: new Date().toISOString(),
      });
    }
    return out;
  }
}
