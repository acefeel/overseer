import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { Note } from './schema.js';

const WIKILINK_RE = /\[\[([^\]\|#]+)(?:\|[^\]]+)?(?:#[^\]]+)?\]\]/g;

export interface IndexedNote extends Note {
  _mtime: number;
}

/**
 * Vault 索引缓存。
 *
 * 首次 scan 全量读取，之后按文件 mtime 增量刷新。
 * 适合 vault 规模不大（< 几千笔记）的场景，能显著降低重复搜索成本。
 */
export class VaultIndex {
  private notes = new Map<string, IndexedNote>();
  private mtimes = new Map<string, number>();
  private initialized = false;

  constructor(public readonly vaultRootAbs: string) {}

  all(): IndexedNote[] {
    this.refresh();
    return [...this.notes.values()];
  }

  private refresh(): void {
    if (!fs.existsSync(this.vaultRootAbs)) return;

    const current = new Set<string>();
    const stack = [this.vaultRootAbs];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (['.obsidian', '.git', 'node_modules', 'templates'].includes(e.name)) continue;
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          current.add(full);
          const mtime = fs.statSync(full).mtimeMs;
          const prev = this.mtimes.get(full);
          if (!this.initialized || prev !== mtime) {
            this.loadFile(full, mtime);
          }
        }
      }
    }

    // 删除已不存在的笔记
    for (const abs of this.mtimes.keys()) {
      if (!current.has(abs)) {
        this.notes.delete(abs);
        this.mtimes.delete(abs);
      }
    }

    this.initialized = true;
  }

  private loadFile(abs: string, mtime: number): void {
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      const parsed = matter(raw);
      const links = [...parsed.content.matchAll(WIKILINK_RE)].map((m) => m[1]);
      const rel = path.relative(this.vaultRootAbs, abs).replace(/\\/g, '/');
      const note: IndexedNote = {
        path: abs,
        relativePath: rel,
        slug: path.basename(abs, '.md'),
        frontmatter: parsed.data as any,
        body: parsed.content,
        links,
        _mtime: mtime,
      };
      this.notes.set(abs, note);
      this.mtimes.set(abs, mtime);
    } catch {
      this.notes.delete(abs);
      this.mtimes.delete(abs);
    }
  }

  invalidate(): void {
    this.initialized = false;
    this.notes.clear();
    this.mtimes.clear();
  }
}
