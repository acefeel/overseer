import chalk from 'chalk';
import { scanProjects, findProject } from '../../projects/scanner.js';
import { readManifest, initManifest, manifestPathFor } from '../../projects/manifest.js';
import { ProjectGit } from '../../vcs/git.js';

export async function runProjects(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'list':
      return list();
    case 'show':
      return show(args[0]);
    case 'init':
      return init(args);
    case 'status':
      return gitStatus(args[0]);
    default:
      console.log(chalk.red(`unknown action: ${action}`));
      console.log(chalk.gray('usage: overseer projects <list|show <id>|init <id> [--allow-write] [--test "cmd"]|status <id>>'));
      process.exit(2);
  }
}

function list(): void {
  const projects = scanProjects();
  if (projects.length === 0) {
    console.log(chalk.gray('no projects detected under workspace'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== ${projects.length} 个项目 ===\n`));
  for (const p of projects) {
    const write = readManifest(p.rootAbs).allowWrite ? chalk.green('writable') : chalk.gray('read-only');
    const tag = p.isGitRepo ? chalk.cyan('[git]') : chalk.gray('[no-git]');
    const manifest = p.hasManifest ? '' : chalk.yellow(' (no .overseer.json, run: overseer projects init ' + p.id + ')');
    console.log(`  ${write}  ${tag}  ${chalk.bold(p.id).padEnd(16)} ${chalk.gray(p.relPath)}${manifest}`);
    console.log(chalk.gray(`       detectedBy: ${p.detectedBy.join(', ')}`));
  }
  console.log();
}

async function show(id?: string): Promise<void> {
  if (!id) {
    console.log(chalk.red('usage: overseer projects show <id>'));
    process.exit(2);
  }
  const p = findProject(id);
  if (!p) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  console.log(chalk.bold.cyan(`\n=== ${p.id} ===\n`));
  console.log(`root:        ${p.rootAbs}`);
  console.log(`relPath:     ${p.relPath}`);
  console.log(`isGitRepo:   ${p.isGitRepo}`);
  console.log(`detectedBy:  ${p.detectedBy.join(', ')}`);
  console.log(`manifest:    ${p.hasManifest ? p.manifestPath : '(none)'}`);
  console.log('\nmanifest content:');
  console.log(chalk.gray(JSON.stringify(readManifest(p.rootAbs), null, 2)));

  if (p.isGitRepo) {
    const git = new ProjectGit(p.rootAbs);
    const s = await git.status();
    console.log('\ngit status:');
    console.log(
      `  branch: ${s.currentBranch ?? '(detached)'}  dirty=${s.dirty} (mod=${s.modified}, untracked=${s.untracked}, staged=${s.staged})  ahead=${s.ahead} behind=${s.behind}  remote=${s.hasRemote}`
    );
  }
  console.log();
}

async function init(args: string[]): Promise<void> {
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.log(chalk.red('usage: overseer projects init <id> [--allow-write] [--test "npm test"]'));
    process.exit(2);
  }
  const p = findProject(id);
  if (!p) {
    console.log(chalk.red(`not found: ${id}. Run "overseer projects list" first.`));
    process.exit(1);
  }
  const flags = parseFlags(args);
  const allowWrite = flags['--allow-write'] === 'true';
  const testCommand = flags['--test'] ?? '';
  const m = initManifest(p.rootAbs, { allowWrite, testCommand });
  console.log(chalk.green(`\ncreated ${manifestPathFor(p.rootAbs)}`));
  console.log(chalk.gray(JSON.stringify(m, null, 2)));
  console.log();
}

async function gitStatus(id?: string): Promise<void> {
  if (!id) {
    console.log(chalk.red('usage: overseer projects status <id>'));
    process.exit(2);
  }
  const p = findProject(id);
  if (!p) {
    console.log(chalk.red(`not found: ${id}`));
    process.exit(1);
  }
  if (!p.isGitRepo) {
    console.log(chalk.gray(`${p.id} is not a git repo`));
    return;
  }
  const git = new ProjectGit(p.rootAbs);
  const s = await git.status();
  console.log(chalk.bold.cyan(`\n=== git status: ${p.id} ===\n`));
  console.log(`  branch:   ${s.currentBranch ?? '(detached)'}`);
  console.log(`  dirty:    ${s.dirty}`);
  console.log(`  modified: ${s.modified}, untracked: ${s.untracked}, staged: ${s.staged}`);
  console.log(`  ahead:    ${s.ahead}, behind: ${s.behind}, remote: ${s.hasRemote}`);
  console.log();
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[a] = next;
        i++;
      } else {
        out[a] = 'true';
      }
    }
  }
  return out;
}
