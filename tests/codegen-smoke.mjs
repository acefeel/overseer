// 测试 CodeChangeGenerator 的 parseAndFilter 逻辑（不调 LLM）
// 用反射访问 private 方法
import { CodeChangeGenerator } from '../dist/supervisor/codegen.js';
import { Router } from '../dist/providers/router.js';
import { loadConfig } from '../dist/util/config.js';

const cfg = loadConfig();
const router = new Router(cfg);
const gen = new CodeChangeGenerator(router);

// mock 一个最小 router（不会真调）
const parseAndFilter = (gen).parseAndFilter.bind(gen);

const DEFAULT_PROTECTED = [
  'config/**', '.secrets.*', 'data/**', 'logs/**', 'vault/**',
  '.obsidian/**', 'dist/**', 'node_modules/**', '*.pid', 'package-lock.json',
];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  if (cond) pass++; else fail++;
}

console.log('=== 1. 正常 JSON：3 个改动 ===');
const r1 = parseAndFilter(JSON.stringify({
  summary: '修了 3 个 TODO',
  changes: [
    { path: 'src/foo.ts', action: 'modify', content: '// new\n', rationale: '修 TODO 1' },
    { path: 'src/bar.ts', action: 'create', content: 'export const X = 1;\n', rationale: '新增' },
    { path: 'README.md', action: 'modify', content: '# Updated\n', rationale: '加文档' },
  ],
}), DEFAULT_PROTECTED);
check('r1 接受 3 个', r1.changes.length === 3, r1.changes.length);
check('r1 summary 透传', r1.summary === '修了 3 个 TODO', r1.summary);
check('r1 没有拒绝', r1.rejected.length === 0, r1.rejected);

console.log('\n=== 2. 受保护路径被拒 ===');
const r2 = parseAndFilter(JSON.stringify({
  summary: '尝试改配置（应被拒）',
  changes: [
    { path: 'config/overseer.config.yaml', action: 'modify', content: 'x: 1\n', rationale: '不该改' },
    { path: 'src/safe.ts', action: 'modify', content: '// ok\n', rationale: '安全的' },
    { path: '.secrets.yaml', action: 'modify', content: 'key: leak\n', rationale: '也不该' },
    { path: 'data/queue.json', action: 'modify', content: '[]', rationale: '也不该' },
    { path: 'package-lock.json', action: 'modify', content: '{}', rationale: '也不该' },
  ],
}), DEFAULT_PROTECTED);
check('r2 只接受 1 个（src/safe.ts）', r2.changes.length === 1, r2.changes);
check('r2 拒绝 4 个', r2.rejected.length === 4, r2.rejected);
check('r2 拒绝理由含"受保护"', r2.rejected.every(r => r.reason.includes('受保护')), r2.rejected);

console.log('\n=== 3. 文件数超限 ===');
const many = Array.from({ length: 8 }, (_, i) => ({
  path: `src/f${i}.ts`, action: 'modify', content: `// ${i}\n`, rationale: `#${i}`,
}));
const r3 = parseAndFilter(JSON.stringify({ summary: '8 个改动', changes: many }), DEFAULT_PROTECTED);
check('r3 接受 5 个（上限）', r3.changes.length === 5, r3.changes.length);
check('r3 拒绝 3 个（超限）', r3.rejected.length === 3, r3.rejected);
check('r3 拒绝理由含"最大文件数"', r3.rejected.every(r => r.reason.includes('最大文件数')), r3.rejected);

console.log('\n=== 4. 字节预算 ===');
const big = Array.from({ length: 5 }, (_, i) => ({
  path: `src/big${i}.ts`,
  action: 'create',
  content: 'x'.repeat(8000),  // 8KB 每个
  rationale: 'big',
}));
const r4 = parseAndFilter(JSON.stringify({ summary: 'big', changes: big }), DEFAULT_PROTECTED);
check('r4 接受 3 个（30KB/8KB）', r4.changes.length === 3, r4.changes.length);
check('r4 拒绝 2 个（超字节）', r4.rejected.length === 2, r4.rejected);

console.log('\n=== 5. 非 JSON / 缺字段 ===');
const r5 = parseAndFilter('not json at all', DEFAULT_PROTECTED);
check('r5 解析失败 → 0 changes', r5.changes.length === 0, r5);
check('r5 有错误 summary', r5.summary.includes('未返回 JSON'), r5.summary);

const r6 = parseAndFilter(JSON.stringify({
  summary: '缺 path',
  changes: [{ action: 'modify', content: 'x', rationale: 'no path' }],
}), DEFAULT_PROTECTED);
check('r6 缺 path → 拒绝', r6.rejected.length === 1 && r6.changes.length === 0, r6);

console.log('\n=== 6. markdown 代码块包裹的 JSON ===');
const r7 = parseAndFilter('```json\n{"summary":"fenced","changes":[]}\n```', DEFAULT_PROTECTED);
check('r7 解析 fence', r7.summary === 'fenced', r7);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
