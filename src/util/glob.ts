import path from 'node:path';

/**
 * 极简 glob 匹配（只支持 *, **, 前缀/后缀），不引外部依赖。
 * 模式示例：
 *   config/**      → config/ 下任意层
 *   .secrets.*     → .secrets.<anything>
 *   *.pid          → 任意 .pid 文件
 *   dist/**        → dist/ 下任意层
 *
 * 对 overSeer 自我保护的场景足够；不通用，别拿去替换真实 glob 库。
 */
export function matchGlob(pattern: string, relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.?\//, '');
  const patterns = pattern.split('/');

  return matchSegments(patterns, normalized.split('/'));
}

function matchSegments(patterns: string[], segments: string[]): boolean {
  if (patterns.length === 0) {
    return segments.length === 0;
  }
  const [head, ...rest] = patterns;
  if (head === '**') {
    if (rest.length === 0) return true;
    for (let i = 0; i <= segments.length; i++) {
      if (matchSegments(rest, segments.slice(i))) return true;
    }
    return false;
  }
  if (segments.length === 0) return false;
  if (matchOne(head, segments[0])) {
    return matchSegments(rest, segments.slice(1));
  }
  return false;
}

function matchOne(pattern: string, name: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === name;
  }
  let regex = '^';
  for (const ch of pattern) {
    if (ch === '*') regex += '[^/]*';
    else if (ch === '?') regex += '[^/]';
    else if ('.+()[]{}|^$\\'.includes(ch)) regex += '\\' + ch;
    else regex += ch;
  }
  regex += '$';
  return new RegExp(regex).test(name);
}

export function isProtected(relPath: string, protectedPatterns: string[]): boolean {
  const norm = path.normalize(relPath).replace(/\\/g, '/');
  return protectedPatterns.some((p) => matchGlob(p, norm));
}
