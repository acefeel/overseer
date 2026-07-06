import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import chalk from 'chalk';
import { select, input } from '@inquirer/prompts';
import { PATHS, resolveWorkspaceRoot } from './paths.js';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';

/**
 * 工作目录解析模块。
 *
 * 解析优先级（高 → 低）：
 *   1. session 内存覆盖（来自 CLI 全局 `--workspace <path>`，仅本次运行生效）
 *   2. 环境变量 `OVERSEER_WORKSPACE`（daemon spawn 时注入，便于后台进程继承）
 *   3. 持久化文件 `data/workspace.json`（`overseer workspace set` 写入，全局生效）
 *   4. 配置文件 `config.workspace.root`（默认 `.`）
 *   5. 兜底：overSeer 项目根目录
 *
 * 所有命令（CLI / daemon / TUI）都通过 `resolveWorkspace()` 拿到统一的绝对路径。
 */

const WORKSPACE_FILE = path.join(PATHS.DATA_DIR, 'workspace.json');

/** session 级覆盖；undefined = 未通过 session 设置 */
let _sessionWs: string | undefined;
/** session 级跳过提示标记（workspace 子命令、--no-prompt 等场景使用） */
let _skipPrompt = false;

export interface PersistedWorkspace {
  root: string;
  setAt: string;
}

export type WorkspaceSource =
  | 'session'
  | 'env'
  | 'persisted'
  | 'config'
  | 'default';

/** 把任意路径规范化为绝对路径（相对 process.cwd() 解析，对用户最直观） */
function toAbs(p: string): string {
  return path.resolve(p);
}

function readPersisted(): PersistedWorkspace | null {
  try {
    if (!fs.existsSync(WORKSPACE_FILE)) return null;
    const raw = fs.readFileSync(WORKSPACE_FILE, 'utf8');
    const obj = JSON.parse(raw) as Partial<PersistedWorkspace>;
    if (obj && typeof obj.root === 'string' && obj.root.length > 0) {
      const abs = toAbs(obj.root);
      if (fs.existsSync(abs)) return { root: abs, setAt: obj.setAt ?? '' };
    }
    return null;
  } catch {
    return null;
  }
}

/** 持久化一个 workspace（写入 data/workspace.json，daemon/CLI 共享） */
export function setPersistedWorkspace(absOrRel: string): string {
  const abs = toAbs(absOrRel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`不是有效目录: ${abs}`);
  }
  if (!fs.existsSync(PATHS.DATA_DIR)) {
    fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
  }
  const state: PersistedWorkspace = { root: abs, setAt: new Date().toISOString() };
  fs.writeFileSync(WORKSPACE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return abs;
}

/** 清除持久化 workspace（回退到 config.workspace.root） */
export function clearPersistedWorkspace(): boolean {
  try {
    if (fs.existsSync(WORKSPACE_FILE)) {
      fs.unlinkSync(WORKSPACE_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 设置 session 级覆盖（来自 --workspace）。传 undefined 清除 */
export function setSessionWorkspace(absOrRel: string | undefined): void {
  _sessionWs = absOrRel ? toAbs(absOrRel) : undefined;
}

/** 标记本次进程跳过启动提示（workspace 子命令 / --no-prompt 使用） */
export function skipWorkspacePrompt(): void {
  _skipPrompt = true;
}

/** 当前 workspace 是否被"显式"设置（session / env / 持久化任一）。config 默认值不算显式 */
export function isWorkspaceExplicitlySet(): boolean {
  if (_sessionWs !== undefined) return true;
  if (process.env.OVERSEER_WORKSPACE) return true;
  return readPersisted() !== null;
}

/** 解析当前生效的 workspace 根目录（绝对路径） */
export function resolveWorkspace(): string {
  if (_sessionWs !== undefined) return _sessionWs;
  const env = process.env.OVERSEER_WORKSPACE;
  if (env && env.length > 0) {
    const abs = toAbs(env);
    if (fs.existsSync(abs)) return abs;
  }
  const persisted = readPersisted();
  if (persisted) return persisted.root;
  const cfg = loadConfig();
  const raw = cfg.workspace.root?.trim();
  if (!raw || raw === '.') {
    // 默认值：overSeer 项目根（保持向后兼容）
    return PATHS.ROOT;
  }
  return resolveWorkspaceRoot(raw);
}

/** 返回当前 workspace 的来源描述，用于 show / doctor */
export function workspaceSource(): { source: WorkspaceSource; root: string; detail?: string } {
  if (_sessionWs !== undefined) {
    return { source: 'session', root: _sessionWs, detail: '--workspace 参数（仅本次运行）' };
  }
  const env = process.env.OVERSEER_WORKSPACE;
  if (env && env.length > 0) {
    const abs = toAbs(env);
    if (fs.existsSync(abs)) return { source: 'env', root: abs, detail: 'OVERSEER_WORKSPACE 环境变量' };
  }
  const persisted = readPersisted();
  if (persisted) {
    return { source: 'persisted', root: persisted.root, detail: `data/workspace.json (setAt ${persisted.setAt})` };
  }
  const cfg = loadConfig();
  const raw = cfg.workspace.root?.trim();
  if (!raw || raw === '.') {
    return { source: 'default', root: PATHS.ROOT, detail: '默认（overSeer 项目根目录）' };
  }
  return { source: 'config', root: resolveWorkspaceRoot(raw), detail: `config.workspace.root = ${raw}` };
}

// ---------------------------------------------------------------------------
// 候选项目目录列举
// ---------------------------------------------------------------------------

const PROJECT_MARKERS = ['.git', 'package.json', 'AGENTS.md', '.overseer.json'] as const;

export interface CandidateProject {
  path: string;
  name: string;
  markers: string[];
}

/**
 * 扫描某个起始目录（默认用户 home）下包含项目标记的子目录，作为可选工作目录候选。
 * 同时把起始目录自身纳入候选。
 */
export function listCandidateProjects(startDir?: string, maxScan = 200): CandidateProject[] {
  const start = startDir ? toAbs(startDir) : os.homedir();
  const out: CandidateProject[] = [];

  const check = (dir: string): string[] => {
    const markers: string[] = [];
    for (const m of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(dir, m))) markers.push(m);
    }
    return markers;
  };

  if (fs.existsSync(start) && fs.statSync(start).isDirectory()) {
    const selfMarkers = check(start);
    if (selfMarkers.length > 0) {
      out.push({ path: start, name: path.basename(start) || start, markers: selfMarkers });
    }
    let top: fs.Dirent[];
    try {
      top = fs.readdirSync(start, { withFileTypes: true });
    } catch {
      return out;
    }
    let scanned = 0;
    for (const e of top) {
      if (scanned >= maxScan) break;
      if (!e.isDirectory()) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      scanned++;
      const full = path.join(start, e.name);
      const markers = check(full);
      if (markers.length > 0) {
        out.push({ path: full, name: e.name, markers });
      }
    }
  }
  return out;
}

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.vscode',
  '.idea',
  'vault',
  'data',
  'logs',
  '.obsidian',
  'AppData',
  'Library',
  '.cache',
  'tmp',
  'temp',
]);

// ---------------------------------------------------------------------------
// 启动交互提示
// ---------------------------------------------------------------------------

/**
 * 当 workspace 未被显式设置且配置允许时，交互提示用户选择工作目录。
 * 仅在交互式 TTY 环境下触发；非 TTY 直接跳过。
 *
 * 可通过 `skipWorkspacePrompt()` 或配置 `workspace.promptIfUnset: false` 关闭。
 */
export async function promptWorkspaceIfUnset(): Promise<void> {
  if (_skipPrompt) return;
  const log = getLogger('workspace');
  if (isWorkspaceExplicitlySet()) return;

  let promptEnabled = true;
  try {
    promptEnabled = loadConfig().workspace.promptIfUnset;
  } catch {
    /* 配置解析失败时仍允许提示 */
  }
  if (!promptEnabled) return;

  // 非交互环境（daemon 后台、管道）不提示
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  const fallback = resolveWorkspace();
  console.log(chalk.cyan('\n=== 选择工作目录 ==='));
  console.log(chalk.gray(`overSeer 尚未被分配工作目录（当前将使用：${fallback}）。`));

  // 从用户 home 与 cwd 两个常见起点收集候选
  const candidates = dedupeCandidates([
    ...listCandidateProjects(os.homedir()),
    ...listCandidateProjects(process.cwd()),
  ]);

  const choices: Array<{ name: string; value: string }> = [];
  for (const c of candidates.slice(0, 15)) {
    const tag = c.markers.includes('.git') ? '[git]' : '[proj]';
    const rel = shortenForDisplay(c.path);
    choices.push({ name: `${tag} ${c.name}  ${chalk.gray(rel)}`, value: c.path });
  }
  choices.push({ name: chalk.yellow('✎ 手动输入路径...'), value: '__manual__' });
  choices.push({ name: chalk.gray('⏎ 跳过本次（使用上方默认）'), value: '__skip__' });
  choices.push({ name: chalk.gray('⊘ 跳过且不再提示'), value: '__disable__' });

  let answer: string;
  try {
    answer = await select({
      message: '请选择被监理的工作目录：',
      choices,
      pageSize: 12,
    });
  } catch {
    return; // Ctrl+C 等中断，直接跳过
  }

  if (answer === '__skip__') {
    _sessionWs = fallback;
    console.log(chalk.gray(`本次使用：${fallback}\n`));
    return;
  }
  if (answer === '__disable__') {
    _sessionWs = fallback;
    try {
      disablePromptInLocalConfig();
    } catch (e) {
      log.warn({ err: String(e) }, '无法写入 local config 关闭提示');
    }
    console.log(chalk.gray(`已关闭启动提示，本次使用：${fallback}\n`));
    return;
  }
  if (answer === '__manual__') {
    let manual: string;
    try {
      manual = await input({ message: '输入工作目录的绝对或相对路径：', default: '' });
    } catch {
      return;
    }
    const trimmed = manual.trim();
    if (!trimmed) {
      _sessionWs = fallback;
      return;
    }
    answer = trimmed;
  }

  // 询问是否持久化（daemon / 后续命令共享）
  let persist = false;
  try {
    persist =
      (await select({
        message: '是否记住该目录供后续（含 daemon）使用？',
        choices: [
          { name: chalk.green('是，记住（写入 data/workspace.json）'), value: 'yes' },
          { name: chalk.gray('否，仅本次生效'), value: 'no' },
        ],
      })) === 'yes';
  } catch {
    /* 中断则不持久化 */
  }

  try {
    if (persist) {
      const abs = setPersistedWorkspace(answer);
      _sessionWs = abs;
      console.log(chalk.green(`\n✓ 已记住工作目录：${abs}\n`));
    } else {
      _sessionWs = toAbs(answer);
      console.log(chalk.green(`\n✓ 本次工作目录：${_sessionWs}\n`));
    }
    log.info({ root: _sessionWs, persisted: persist }, 'workspace assigned');
  } catch (e) {
    console.log(chalk.red(`\n✗ 无效目录：${(e as Error).message}\n`));
    _sessionWs = fallback;
  }
}

function dedupeCandidates(list: CandidateProject[]): CandidateProject[] {
  const seen = new Set<string>();
  const out: CandidateProject[] = [];
  for (const c of list) {
    const key = path.resolve(c.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function shortenForDisplay(abs: string): string {
  const home = os.homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + path.sep)) return '~' + abs.slice(home.length);
  return abs;
}

/** 把 workspace.promptIfUnset=false 写入 local config，实现"不再提示" */
function disablePromptInLocalConfig(): void {
  const fsSync = fs;
  const local = PATHS.LOCAL_CONFIG;
  const content = `# 由 overSeer 自动写入：关闭启动时的工作目录提示\nworkspace:\n  promptIfUnset: false\n`;
  if (fsSync.existsSync(local)) {
    fsSync.appendFileSync(local, '\n' + content, 'utf8');
  } else {
    fsSync.writeFileSync(local, content, 'utf8');
  }
}
