import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { VaultIndex } from './index.js';
import { Vault } from './vault.js';
import type { Note, NoteType } from './schema.js';

export interface SearchQuery {
  q?: string;
  type?: NoteType;
  project?: string;
  tag?: string;
  status?: string;
  since?: string;
  limit?: number;
}

export interface ScoredNote {
  note: Note;
  score: number;
  snippet: string;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'of', 'to', 'in', 'on', 'for', 'and', 'or',
  '的', '了', '是', '在', '和', '与', '或', '及', '等', '为',
]);

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
  const cjk = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  const cjkChunks: string[] = [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length; i++) {
      cjkChunks.push(seg.slice(i, i + 1));
      if (i + 2 <= seg.length) cjkChunks.push(seg.slice(i, i + 2));
    }
  }
  return [...ascii, ...cjkChunks].filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export class VaultRetriever {
  private index: VaultIndex;

  constructor(public readonly vault: Vault) {
    this.index = new VaultIndex(vault.rootAbs);
  }

  all(): Note[] {
    return this.index.all();
  }

  invalidate(): void {
    this.index.invalidate();
  }

  search(query: SearchQuery): ScoredNote[] {
    const notes = this.all();
    const limit = query.limit ?? 20;
    const wantTokens = query.q ? new Set(tokenize(query.q)) : null;

    const scored: ScoredNote[] = [];
    for (const note of notes) {
      const fm = note.frontmatter as any;
      if (query.type && fm.type !== query.type) continue;
      if (query.project && fm.project !== query.project) continue;
      if (query.status && fm.status !== query.status) continue;
      if (query.tag && !(Array.isArray(fm.tags) && fm.tags.includes(query.tag))) continue;
      if (query.since && (fm.date ?? '') < query.since) continue;

      if (!wantTokens) {
        scored.push({ note, score: 0, snippet: snippet(note.body, 0) });
        continue;
      }

      const titleText = `${note.slug} ${fm.title ?? ''} ${(fm.aliases ?? []).join(' ')}`;
      const tagText = Array.isArray(fm.tags) ? fm.tags.join(' ') : '';
      const titleTokens = new Set(tokenize(titleText + ' ' + tagText));

      let score = 0;
      for (const t of wantTokens) {
        if (titleTokens.has(t)) score += 5;
      }
      let bodyHits = 0;
      let firstIdx = -1;
      const lowerBody = note.body.toLowerCase();
      for (const t of wantTokens) {
        const idx = lowerBody.indexOf(t);
        if (idx >= 0) {
          bodyHits++;
          if (firstIdx < 0 || idx < firstIdx) firstIdx = idx;
        }
      }
      score += bodyHits * 2;

      if (score === 0 && bodyHits === 0) continue;
      scored.push({ note, score, snippet: snippet(note.body, firstIdx) });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  recent(limit = 10, type?: NoteType): Note[] {
    const notes = this.all().filter((n) => !type || (n.frontmatter as any).type === type);
    notes.sort((a: any, b: any) => (b._mtime ?? 0) - (a._mtime ?? 0));
    return notes.slice(0, limit);
  }

  show(rel: string): Note | null {
    const abs = path.isAbsolute(rel) ? rel : path.join(this.vault.rootAbs, rel);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, 'utf8');
    const parsed = matter(raw);
    const links = [...parsed.content.matchAll(/\[\[([^\]\|#]+)(?:\|[^\]]+)?(?:#[^\]]+)?\]\]/g)].map(
      (m) => m[1]
    );
    return {
      path: abs,
      relativePath: this.vault.rel(abs),
      slug: path.basename(abs, '.md'),
      frontmatter: parsed.data as any,
      body: parsed.content,
      links,
    };
  }

  renderContext(notes: ScoredNote[] | Note[], opts: { maxChars?: number } = {}): string {
    const max = opts.maxChars ?? 3000;
    let out = '';
    let used = 0;
    for (const item of notes) {
      const note = 'note' in item ? item.note : item;
      const fm = note.frontmatter as any;
      const head = `### [[${note.relativePath.replace(/\.md$/, '')}]]  ·  type=${fm.type ?? '?'}  ·  ${fm.date ?? ''}\n`;
      const body = note.body.slice(0, Math.max(200, max - used - head.length - 50));
      const block = head + body + '\n\n';
      if (used + block.length > max) break;
      out += block;
      used += block.length;
    }
    return out.trim() || '(no matching notes)';
  }
}

function snippet(body: string, idx: number, radius = 120): string {
  if (idx < 0) return body.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + radius);
  return (start > 0 ? '… ' : '') + body.slice(start, end).trim() + (end < body.length ? ' …' : '');
}
