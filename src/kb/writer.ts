import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { getLogger } from '../util/logger.js';
import { Vault } from './vault.js';
import {
  type Frontmatter,
  type Note,
  type NoteType,
  slugify,
  todayStr,
} from './schema.js';

const WIKILINK_RE = /\[\[([^\]\|#]+)(?:\|[^\]]+)?(?:#[^\]]+)?\]\]/g;

export interface WriteOptions {
  type: NoteType;
  project?: string;
  slug?: string;
  title?: string;
  tags?: string[];
  status?: Frontmatter['status'];
  body: string;
  appendIfExisting?: boolean;
  aliases?: string[];
}

export interface WriteResult {
  note: Note;
  created: boolean;
}

export class VaultWriter {
  private log = getLogger('kb:writer');
  constructor(public readonly vault: Vault) {}

  write(opts: WriteOptions): WriteResult {
    const project = opts.project ?? 'overSeer';
    const slug = opts.slug ?? slugify(opts.title ?? 'untitled');
    const date = todayStr();
    const { abs, rel } = this.vault.resolveNotePath(opts.type, project, slug, date);

    const fm: Frontmatter = {
      type: opts.type,
      date,
      project,
      tags: opts.tags ?? [],
      status: opts.status ?? 'active',
      title: opts.title ?? slug,
      ...(opts.aliases ? { aliases: opts.aliases } : {}),
      createdAt: new Date().toISOString(),
    };

    const existed = fs.existsSync(abs);
    let content: string;
    if (existed && opts.appendIfExisting) {
      const prev = fs.readFileSync(abs, 'utf8');
      const parsed = matter(prev);
      const mergedFm = { ...parsed.data, ...fm, updatedAt: new Date().toISOString() } as Frontmatter;
      const append = `\n\n---\n\n### ${new Date().toISOString()}\n\n${opts.body.trim()}\n`;
      content = matter.stringify(parsed.content + append, mergedFm as any);
    } else if (existed) {
      const mergedFm = { ...fm, updatedAt: new Date().toISOString() };
      content = matter.stringify(opts.body.trim() + '\n', mergedFm as any);
    } else {
      content = matter.stringify(opts.body.trim() + '\n', fm as any);
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    this.log.info({ rel, type: opts.type, created: !existed }, 'note written');
    return { note: this.readNote(abs)!, created: !existed };
  }

  appendDaily(section: string, body: string): WriteResult {
    const slug = todayStr();
    return this.write({
      type: 'daily',
      slug,
      title: `${slug} 日志`,
      tags: ['daily'],
      appendIfExisting: true,
      body: `### ${section}\n\n${body.trim()}`,
    });
  }

  private readNote(abs: string): Note | null {
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = matter(raw);
    const fm = parsed.data as unknown as Frontmatter;
    const links = [...parsed.content.matchAll(WIKILINK_RE)].map((m) => m[1]);
    return {
      path: abs,
      relativePath: this.vault.rel(abs),
      slug: path.basename(abs, '.md'),
      frontmatter: fm,
      body: parsed.content,
      links,
    };
  }

  readByRel(rel: string): Note | null {
    const abs = path.isAbsolute(rel) ? rel : path.join(this.vault.rootAbs, rel);
    return this.readNote(abs);
  }

  appendToNote(rel: string, section: string, body: string): Note | null {
    const abs = path.join(this.vault.rootAbs, rel);
    if (!fs.existsSync(abs)) return null;
    const prev = fs.readFileSync(abs, 'utf8');
    const parsed = matter(prev);
    const fm = { ...parsed.data, updatedAt: new Date().toISOString() } as Frontmatter;
    const append = `\n\n### ${section}\n\n${body.trim()}\n`;
    const content = matter.stringify(parsed.content + append, fm as any);
    fs.writeFileSync(abs, content, 'utf8');
    return this.readNote(abs);
  }

  static extractWikilinks(text: string): string[] {
    return [...text.matchAll(WIKILINK_RE)].map((m) => m[1]);
  }
}
