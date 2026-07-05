import chalk from 'chalk';
import { loadConfig } from '../../util/config.js';
import { Vault } from '../../kb/vault.js';
import { VaultWriter, type WriteOptions } from '../../kb/writer.js';
import { VaultRetriever } from '../../kb/retriever.js';
import type { NoteType } from '../../kb/schema.js';

export async function runKb(action: string, args: string[]): Promise<void> {
  switch (action) {
    case 'search':
      return search(args);
    case 'show':
      return show(args[0]);
    case 'recent':
      return recent(args);
    case 'write':
      return manualWrite(args);
    case 'stats':
      return stats();
    default:
      console.log(chalk.red(`unknown kb action: ${action}`));
      console.log(
        chalk.gray('usage: overseer kb <search <q> | show <relpath> | recent [--type T] | write --type T --title ... | stats>')
      );
      process.exit(2);
  }
}

function getKb() {
  void loadConfig();
  const v = new Vault();
  v.ensure();
  return { v, w: new VaultWriter(v), r: new VaultRetriever(v) };
}

function search(args: string[]): void {
  const q = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!q) {
    console.log(chalk.red('usage: overseer kb search <query>'));
    process.exit(2);
  }
  const { r } = getKb();
  const hits = r.search({ q, limit: 20 });
  if (hits.length === 0) {
    console.log(chalk.gray(`no notes match "${q}"`));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== ${hits.length} 条命中（按相关度排序）===\n`));
  for (const h of hits) {
    const fm = h.note.frontmatter as any;
    console.log(
      chalk.green(`  [${h.score}]`) +
        chalk.yellow(` (${fm.type ?? '?'}/${fm.project ?? '?'})`) +
        ' ' +
        chalk.bold(h.note.slug) +
        chalk.gray(`  · ${fm.date ?? ''}  ·  ${h.note.relativePath}`)
    );
    console.log(chalk.gray(`    ${h.snippet.replace(/\n/g, ' ').slice(0, 140)}`));
  }
  console.log();
}

function show(rel?: string): void {
  if (!rel) {
    console.log(chalk.red('usage: overseer kb show <relative-path-without-.md>'));
    process.exit(2);
  }
  const { r } = getKb();
  const target = rel.endsWith('.md') ? rel : rel + '.md';
  const note = r.show(target);
  if (!note) {
    console.log(chalk.red(`not found: ${target}`));
    process.exit(1);
  }
  const fm = note.frontmatter as any;
  console.log(chalk.bold.cyan(`\n=== ${note.relativePath} ===\n`));
  console.log(chalk.gray('--- frontmatter ---'));
  console.log(chalk.gray(JSON.stringify(fm, null, 2)));
  console.log(chalk.gray('--- body ---'));
  console.log(note.body.trim());
  if (note.links.length > 0) {
    console.log(chalk.gray('\n--- links ---'));
    console.log(chalk.gray(note.links.join(', ')));
  }
  console.log();
}

function recent(args: string[]): void {
  const typeIdx = args.indexOf('--type');
  const type = typeIdx >= 0 ? (args[typeIdx + 1] as NoteType) : undefined;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 10;
  const { r } = getKb();
  const notes = r.recent(limit, type);
  if (notes.length === 0) {
    console.log(chalk.gray('vault is empty'));
    return;
  }
  console.log(chalk.bold.cyan(`\n=== 最近 ${notes.length} 条 ===\n`));
  for (const n of notes) {
    const fm = n.frontmatter as any;
    console.log(
      chalk.yellow(` (${fm.type ?? '?'})`) +
        ' ' +
        chalk.bold(n.slug) +
        chalk.gray(`  · ${fm.date ?? ''}  ·  ${n.relativePath}`)
    );
  }
  console.log();
}

function manualWrite(args: string[]): void {
  const flags = parseFlags(args);
  const type = (flags['--type'] as NoteType) ?? 'knowledge';
  const title = flags['--title'];
  const project = (flags['--project'] ?? 'overSeer') as string;
  const tags = (flags['--tags'] ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const body = flags['--body'];
  if (!title || !body) {
    console.log(chalk.red('usage: overseer kb write --type <T> --title "..." --body "..." [--project overSeer] [--tags a,b]'));
    console.log(chalk.gray('type ∈ moc|daily|adr|budget|plan|design|retro|knowledge|chat_log'));
    process.exit(2);
  }
  const { w } = getKb();
  const opts: WriteOptions = { type, project, title, tags, body };
  const res = w.write(opts);
  console.log(chalk.green(`\n${res.created ? 'created' : 'updated'}: ${res.note.relativePath}\n`));
}

function stats(): void {
  const { r } = getKb();
  const all = r.all();
  const byType: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const n of all) {
    const fm = n.frontmatter as any;
    byType[fm.type ?? '?'] = (byType[fm.type ?? '?'] ?? 0) + 1;
    byProject[fm.project ?? '?'] = (byProject[fm.project ?? '?'] ?? 0) + 1;
  }
  console.log(chalk.bold.cyan(`\n=== vault stats ===\n`));
  console.log(`total notes: ${chalk.green(String(all.length))}\n`);
  console.log(chalk.bold('by type:'));
  for (const k of Object.keys(byType).sort()) {
    console.log(`  ${k.padEnd(12)} ${byType[k]}`);
  }
  console.log(chalk.bold('\nby project:'));
  for (const k of Object.keys(byProject).sort()) {
    console.log(`  ${k.padEnd(12)} ${byProject[k]}`);
  }
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
