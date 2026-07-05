import { describe, it, expect } from 'vitest';
import { CodeChangeGenerator } from '../src/supervisor/codegen.js';
import { Router } from '../src/providers/router.js';
import { loadConfig } from '../src/util/config.js';

const DEFAULT_PROTECTED = [
  'config/**', '.secrets.*', 'data/**', 'logs/**', 'vault/**',
  '.obsidian/**', 'dist/**', 'node_modules/**', '*.pid', 'package-lock.json',
];

describe('CodeChangeGenerator.parseAndFilter', () => {
  const cfg = loadConfig();
  const router = new Router(cfg);
  const gen = new CodeChangeGenerator(router);
  const parseAndFilter = (gen as any).parseAndFilter.bind(gen);

  it('正常 JSON：接受 3 个改动', () => {
    const r = parseAndFilter(JSON.stringify({
      summary: '修了 3 个 TODO',
      changes: [
        { path: 'src/foo.ts', action: 'modify', content: '// new\n', rationale: '修 TODO 1' },
        { path: 'src/bar.ts', action: 'create', content: 'export const X = 1;\n', rationale: '新增' },
        { path: 'README.md', action: 'modify', content: '# Updated\n', rationale: '加文档' },
      ],
    }), DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(3);
    expect(r.summary).toBe('修了 3 个 TODO');
    expect(r.rejected.length).toBe(0);
  });

  it('受保护路径被拒', () => {
    const r = parseAndFilter(JSON.stringify({
      summary: '尝试改配置（应被拒）',
      changes: [
        { path: 'config/overseer.config.yaml', action: 'modify', content: 'x: 1\n', rationale: '不该改' },
        { path: 'src/safe.ts', action: 'modify', content: '// ok\n', rationale: '安全的' },
        { path: '.secrets.yaml', action: 'modify', content: 'key: leak\n', rationale: '也不该' },
        { path: 'data/queue.json', action: 'modify', content: '[]', rationale: '也不该' },
        { path: 'package-lock.json', action: 'modify', content: '{}', rationale: '也不该' },
      ],
    }), DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(1);
    expect(r.rejected.length).toBe(4);
    expect(r.rejected.every((x: any) => x.reason.includes('受保护'))).toBe(true);
  });

  it('文件数超限：最多接受 5 个', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      path: `src/f${i}.ts`, action: 'modify', content: `// ${i}\n`, rationale: `#${i}`,
    }));
    const r = parseAndFilter(JSON.stringify({ summary: '8 个改动', changes: many }), DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(5);
    expect(r.rejected.length).toBe(3);
    expect(r.rejected.every((x: any) => x.reason.includes('最大文件数'))).toBe(true);
  });

  it('字节预算超限：30KB 上限', () => {
    const big = Array.from({ length: 5 }, (_, i) => ({
      path: `src/big${i}.ts`,
      action: 'create',
      content: 'x'.repeat(8000),
      rationale: 'big',
    }));
    const r = parseAndFilter(JSON.stringify({ summary: 'big', changes: big }), DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(3);
    expect(r.rejected.length).toBe(2);
  });

  it('非 JSON 返回空 changes 与错误 summary', () => {
    const r = parseAndFilter('not json at all', DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(0);
    expect(r.summary).toContain('未返回 JSON');
  });

  it('缺 path 的 change 被拒绝', () => {
    const r = parseAndFilter(JSON.stringify({
      summary: '缺 path',
      changes: [{ action: 'modify', content: 'x', rationale: 'no path' }],
    }), DEFAULT_PROTECTED);
    expect(r.changes.length).toBe(0);
    expect(r.rejected.length).toBe(1);
  });

  it('markdown 代码块包裹的 JSON 可解析', () => {
    const r = parseAndFilter('```json\n{"summary":"fenced","changes":[]}\n```', DEFAULT_PROTECTED);
    expect(r.summary).toBe('fenced');
  });
});
