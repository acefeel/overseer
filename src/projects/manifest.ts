import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const ProjectManifestSchema = z.object({
  version: z.number().int().default(1),
  /** 是否允许 overSeer 写代码（false = 只读监理） */
  allowWrite: z.boolean().default(false),
  /** 允许 overSeer 自动执行的 shell 命令前缀（如 ['npm test', 'npm run build']） */
  allowExec: z.array(z.string()).default([]),
  /** 哪些动作需要 CLI approve：默认 catch-all 'git.push' 'file.delete' 等 */
  requiresApproval: z.array(z.string()).default(['git.push', 'file.delete', 'shell.exec']),
  /** 主分支名（不允许直接改） */
  mainBranch: z.string().default('main'),
  /** 测试命令；为空表示不跑 */
  testCommand: z.string().default(''),
  /**
   * 受保护路径（glob 风格字符串数组）。
   * overSeer 自己永远不能改这些文件 —— 用于自改进时防止"自残"。
   * 默认包含：配置/密钥/数据/vault/构建产物
   */
  protectedPaths: z.array(z.string()).default([
    'config/**',
    '.secrets.*',
    'data/**',
    'logs/**',
    'vault/**',
    '.obsidian/**',
    'dist/**',
    'node_modules/**',
    '*.pid',
    'package-lock.json',
  ]),
  /** 备注 */
  notes: z.string().default(''),
});
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const DEFAULT_MANIFEST: ProjectManifest = ProjectManifestSchema.parse({});

export function manifestPathFor(projectRootAbs: string): string {
  return path.join(projectRootAbs, '.overseer.json');
}

export function readManifest(projectRootAbs: string): ProjectManifest {
  const p = manifestPathFor(projectRootAbs);
  if (!fs.existsSync(p)) return { ...DEFAULT_MANIFEST };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return ProjectManifestSchema.parse(raw);
  } catch (e) {
    return { ...DEFAULT_MANIFEST, notes: `manifest parse failed: ${(e as Error).message}` };
  }
}

export function writeManifest(projectRootAbs: string, m: Partial<ProjectManifest>): ProjectManifest {
  const merged = { ...readManifest(projectRootAbs), ...m };
  const valid = ProjectManifestSchema.parse(merged);
  fs.writeFileSync(
    manifestPathFor(projectRootAbs),
    JSON.stringify(valid, null, 2) + '\n',
    'utf8'
  );
  return valid;
}

export function initManifest(
  projectRootAbs: string,
  opts: { allowWrite?: boolean; testCommand?: string } = {}
): ProjectManifest {
  return writeManifest(projectRootAbs, {
    allowWrite: opts.allowWrite ?? false,
    testCommand: opts.testCommand ?? '',
  });
}
