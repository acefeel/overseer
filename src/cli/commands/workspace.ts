import chalk from 'chalk';
import os from 'node:os';
import { select, input } from '@inquirer/prompts';
import {
  resolveWorkspace,
  workspaceSource,
  setPersistedWorkspace,
  clearPersistedWorkspace,
  listCandidateProjects,
  isWorkspaceExplicitlySet,
  type CandidateProject,
} from '../../util/workspace.js';
import { loadConfig } from '../../util/config.js';

export async function runWorkspace(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'show':
      return show();
    case 'set':
      return set(args[0]);
    case 'clear':
    case 'unset':
      return clear();
    case 'list':
      return list(args[0]);
    case 'pick':
      return pick();
    default:
      console.log(chalk.red(`unknown action: ${action}`));
      console.log(
        chalk.gray('usage: overseer workspace <show | set <path> | clear | list [dir] | pick>')
      );
      process.exit(2);
  }
}

function show(): void {
  const info = workspaceSource();
  const explicit = isWorkspaceExplicitlySet();
  console.log(chalk.bold.cyan('\n=== workspace ===\n'));
  console.log(`  root:     ${chalk.green(info.root)}`);
  console.log(`  source:   ${chalk.cyan(info.source)}${explicit ? '' : chalk.gray(' (未显式设置，使用默认)')}`);
  console.log(`  detail:   ${chalk.gray(info.detail ?? '-')}`);
  let promptEnabled = true;
  try {
    promptEnabled = loadConfig().workspace.promptIfUnset;
  } catch {
    /* ignore */
  }
  console.log(`  prompt:   ${promptEnabled ? chalk.yellow('启动时交互提示已开启') : chalk.gray('启动提示已关闭')}`);
  console.log();
}

function set(p?: string): void {
  if (!p) {
    console.log(chalk.red('usage: overseer workspace set <path>'));
    console.log(chalk.gray('  持久化写入 data/workspace.json，daemon 与后续 CLI 共享。'));
    process.exit(2);
  }
  try {
    const abs = setPersistedWorkspace(p);
    console.log(chalk.green(`\n✓ 已设置工作目录：${abs}`));
    console.log(chalk.gray('  daemon 与后续 CLI 命令将使用该目录。可用 `overseer workspace clear` 清除。\n'));
  } catch (e) {
    console.log(chalk.red(`\n✗ 设置失败：${(e as Error).message}\n`));
    process.exit(1);
  }
}

function clear(): void {
  const removed = clearPersistedWorkspace();
  if (removed) {
    console.log(chalk.green('\n✓ 已清除持久化工作目录，回退到 config.workspace.root。\n'));
  } else {
    console.log(chalk.gray('\n（无持久化工作目录可清除）\n'));
  }
}

function list(dir?: string): void {
  const start = dir ?? resolveWorkspace();
  const candidates = listCandidateProjects(start);
  console.log(chalk.bold.cyan(`\n=== 候选项目（扫描自 ${start}）===\n`));
  if (candidates.length === 0) {
    console.log(chalk.gray('未发现含 .git/package.json/AGENTS.md/.overseer.json 的目录。\n'));
    return;
  }
  for (const c of candidates) {
    const tag = c.markers.includes('.git') ? chalk.cyan('[git]') : chalk.gray('[proj]');
    console.log(`  ${tag}  ${chalk.bold(c.name).padEnd(20)} ${chalk.gray(c.path)}`);
    console.log(chalk.gray(`        markers: ${c.markers.join(', ')}`));
  }
  console.log();
}

async function pick(): Promise<void> {
  console.log(chalk.bold.cyan('\n=== 选择工作目录 ===\n'));

  // 双起点收集候选
  const candidates = dedupe([
    ...listCandidateProjects(os.homedir()),
    ...listCandidateProjects(process.cwd()),
  ]);

  const choices: Array<{ name: string; value: string }> = candidates.slice(0, 20).map((c) => ({
    name: `${c.markers.includes('.git') ? '[git]' : '[proj]'} ${c.name}  ${chalk.gray(c.path)}`,
    value: c.path,
  }));
  choices.push({ name: chalk.yellow('✎ 手动输入路径...'), value: '__manual__' });

  let picked: string;
  try {
    picked = await select({
      message: '选择要监理的工作目录：',
      choices,
      pageSize: 15,
    });
  } catch {
    console.log(chalk.gray('\n已取消。\n'));
    return;
  }

  if (picked === '__manual__') {
    try {
      picked = await input({ message: '输入工作目录路径：', default: '' });
    } catch {
      return;
    }
    if (!picked.trim()) {
      console.log(chalk.gray('\n未输入，已取消。\n'));
      return;
    }
  }

  let persist = true;
  try {
    persist =
      (await select({
        message: '是否记住该目录供 daemon 与后续命令使用？',
        choices: [
          { name: chalk.green('是，持久化（data/workspace.json）'), value: 'yes' },
          { name: chalk.gray('否，仅本次不生效（pick 不带 --workspace，故仍需持久化或参数）'), value: 'no' },
        ],
      })) === 'yes';
  } catch {
    /* ignore */
  }

  if (!persist) {
    console.log(chalk.gray('\n未持久化。请使用 `overseer --workspace <path> <cmd>` 或 `overseer workspace set <path>`。\n'));
    return;
  }

  try {
    const abs = setPersistedWorkspace(picked);
    console.log(chalk.green(`\n✓ 已记住工作目录：${abs}\n`));
  } catch (e) {
    console.log(chalk.red(`\n✗ 设置失败：${(e as Error).message}\n`));
    process.exit(1);
  }
}

function dedupe(list: CandidateProject[]): CandidateProject[] {
  const seen = new Set<string>();
  const out: CandidateProject[] = [];
  for (const c of list) {
    const key = c.path;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
