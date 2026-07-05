import path from 'node:path';
import fs from 'node:fs';
import { PATHS } from '../util/paths.js';
import { loadConfig } from '../util/config.js';
import type { NoteType } from './schema.js';
import { TYPE_TO_DIR } from './schema.js';

export class Vault {
  readonly rootAbs: string;

  constructor(rootRel?: string) {
    const cfg = loadConfig();
    const rel = rootRel ?? cfg.vault.root;
    this.rootAbs = path.isAbsolute(rel) ? rel : path.resolve(PATHS.ROOT, rel);
  }

  ensure(): void {
    if (!fs.existsSync(this.rootAbs)) {
      fs.mkdirSync(this.rootAbs, { recursive: true });
    }
    for (const sub of [
      'overSeer/daily',
      'overSeer/decisions',
      'overSeer/budgets',
      'overSeer/chat-logs',
      'templates',
    ]) {
      const p = path.join(this.rootAbs, sub);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }
  }

  dirFor(type: NoteType, project: string): string {
    const rel = TYPE_TO_DIR[type](project);
    return path.join(this.rootAbs, rel);
  }

  ensureDirFor(type: NoteType, project: string): string {
    const dir = this.dirFor(type, project);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  resolveNotePath(
    type: NoteType,
    project: string,
    slug: string,
    date?: string
  ): { abs: string; rel: string } {
    const dir = this.ensureDirFor(type, project);
    const prefix = type === 'daily' || type === 'budget' ? `${date ?? ''}-` : '';
    const filename = `${prefix}${slug}.md`;
    const abs = path.join(dir, filename);
    const rel = path.relative(this.rootAbs, abs).replace(/\\/g, '/');
    return { abs, rel };
  }

  walkMarkdowns(): string[] {
    if (!fs.existsSync(this.rootAbs)) return [];
    const out: string[] = [];
    const stack = [this.rootAbs];
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
          if (e.name === '.obsidian' || e.name === '.git' || e.name === 'node_modules' || e.name === 'templates') continue;
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          out.push(full);
        }
      }
    }
    return out;
  }

  rel(absPath: string): string {
    return path.relative(this.rootAbs, absPath).replace(/\\/g, '/');
  }

  exists(relPath: string): boolean {
    return fs.existsSync(path.join(this.rootAbs, relPath));
  }

  read(relPath: string): string {
    return fs.readFileSync(path.join(this.rootAbs, relPath), 'utf8');
  }
}
