import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from '../util/logger.js';
import { resolveWorkspace } from '../util/workspace.js';
import { PATHS } from '../util/paths.js';

export interface ProjectInfo {
  id: string;
  name: string;
  rootAbs: string;
  relPath: string;
  isGitRepo: boolean;
  hasManifest: boolean;
  detectedBy: Array<'git' | 'package.json' | 'AGENTS.md' | 'manifest'>;
  manifestPath?: string;
}

const IGNORE = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vscode',
  '.idea',
  'vault',
  'data',
  'logs',
  '.obsidian',
]);

function projectNameFromRoot(rootAbs: string): string {
  return path.basename(rootAbs);
}

function isProjectRoot(dirAbs: string): ProjectInfo | null {
  const detectedBy: ProjectInfo['detectedBy'] = [];
  if (fs.existsSync(path.join(dirAbs, '.git'))) detectedBy.push('git');
  if (fs.existsSync(path.join(dirAbs, 'package.json'))) detectedBy.push('package.json');
  if (fs.existsSync(path.join(dirAbs, 'AGENTS.md'))) detectedBy.push('AGENTS.md');
  const manifestPath = path.join(dirAbs, '.overseer.json');
  const hasManifest = fs.existsSync(manifestPath);
  if (hasManifest) detectedBy.push('manifest');
  if (detectedBy.length === 0) return null;
  return {
    id: projectNameFromRoot(dirAbs),
    name: projectNameFromRoot(dirAbs),
    rootAbs: dirAbs,
    relPath:
      path.relative(resolveWorkspace(), dirAbs).replace(/\\/g, '/') ||
      path.basename(dirAbs),
    isGitRepo: detectedBy.includes('git'),
    hasManifest,
    detectedBy,
    manifestPath: hasManifest ? manifestPath : undefined,
  };
}

export function scanProjects(): ProjectInfo[] {
  const log = getLogger('projects');
  const ws = resolveWorkspace();
  const out: ProjectInfo[] = [];

  if (fs.existsSync(ws)) {
    // 先检查 workspace 根目录本身是否是一个项目。
    // 这样配置 workspace.root = '.' 时，overSeer 自身会被识别为被监理项目。
    const self = isProjectRoot(ws);
    if (self) out.push(self);

    let top: fs.Dirent[];
    try {
      top = fs.readdirSync(ws, { withFileTypes: true });
    } catch (e) {
      log.warn({ err: String(e), ws }, 'cannot read workspace');
      return out;
    }
    for (const e of top) {
      if (!e.isDirectory()) continue;
      if (IGNORE.has(e.name)) continue;
      const full = path.join(ws, e.name);
      const info = isProjectRoot(full);
      if (info) out.push(info);
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 通过 id 或绝对/相对路径找项目（用于 JHAVSP 这类未被自动检测的目录） */
export function findProject(idOrRel: string): ProjectInfo | null {
  const all = scanProjects();
  const lower = idOrRel.toLowerCase();
  const byId =
    all.find((p) => p.id.toLowerCase() === lower) ??
    all.find((p) => p.relPath.toLowerCase() === lower) ??
    all.find((p) => p.name.toLowerCase() === lower);
  if (byId) return byId;

  // 兜底：当作路径解析
  const abs = path.isAbsolute(idOrRel)
    ? idOrRel
    : path.resolve(PATHS.ROOT, idOrRel);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return {
      id: path.basename(abs),
      name: path.basename(abs),
      rootAbs: abs,
      relPath: path.relative(resolveWorkspace(), abs).replace(/\\/g, '/') || path.basename(abs),
      isGitRepo: fs.existsSync(path.join(abs, '.git')),
      hasManifest: fs.existsSync(path.join(abs, '.overseer.json')),
      detectedBy: fs.existsSync(path.join(abs, '.git')) ? ['git'] : [],
    };
  }
  return null;
}
