import { VaultRetriever, type SearchQuery } from './retriever.js';
import type { Note } from './schema.js';

interface RelatedHit {
  note: Note;
  score: number;
  via: string;
}

/**
 * 在 VaultRetriever 的 TF 打分基础上，增加图关系增强：
 * 1. 入链/出链命中查询词时加分
 * 2. 相似笔记互相投票（协同链接）
 * 3. 支持按相关笔记扩散（related）
 */
export class VaultSearcher {
  constructor(private retriever: VaultRetriever) {}

  search(query: SearchQuery, opts: { linkBoost?: number; relatedDepth?: number } = {}): any[] {
    const hits = this.retriever.search(query);
    if (hits.length === 0) return [];

    const linkBoost = opts.linkBoost ?? 2;
    const relatedDepth = opts.relatedDepth ?? 0;

    // 计算每个命中笔记的链接得分
    const scored = hits.map((h) => {
      let linkScore = 0;
      const q = query.q?.toLowerCase() ?? '';
      for (const link of h.note.links) {
        if (q && link.toLowerCase().includes(q)) linkScore += linkBoost;
      }
      return { ...h, finalScore: h.score + linkScore };
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);

    if (relatedDepth <= 0) return scored;

    // 扩散：把与 top hit 互相链接的笔记也带进来
    const all = this.retriever.all();
    const topRels = new Set(scored.slice(0, 3).map((s) => s.note.relativePath));
    const related: RelatedHit[] = [];
    const seen = new Set(topRels);

    for (const rel of topRels) {
      for (const n of all) {
        if (seen.has(n.relativePath)) continue;
        if (n.links.includes(rel.replace(/\.md$/, '')) || n.links.includes(rel)) {
          related.push({ note: n, score: linkBoost * 0.5, via: rel });
          seen.add(n.relativePath);
        }
      }
    }

    return [...scored, ...related.map((r) => ({ note: r.note, score: r.score, snippet: '', via: r.via }))];
  }

  /** 找与给定笔记最相关的其他笔记 */
  related(relPath: string, limit = 5): { note: Note; score: number }[] {
    const target = this.retriever.show(relPath);
    if (!target) return [];

    const all = this.retriever.all();
    const targetLinks = new Set(target.links);
    const scored = [];
    for (const n of all) {
      if (n.relativePath === target.relativePath) continue;
      let score = 0;
      const mutual = n.links.filter((l) => targetLinks.has(l)).length;
      if (targetLinks.has(n.relativePath.replace(/\.md$/, ''))) score += 3;
      score += mutual * 2;
      if (score > 0) scored.push({ note: n, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}
