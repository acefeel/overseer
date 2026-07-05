/**
 * 从 LLM 输出中提取 JSON 对象或数组。
 *
 * 支持：
 * - markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
 * - 纯文本中找到第一个 { ... } 或 [ ... ]
 * - 兜底返回 null，不抛异常
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const raw = extractJsonText(text, '{', '}');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractJsonArray(text: string): unknown[] | null {
  const raw = extractJsonText(text, '[', ']');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonText(text: string, open: string, close: string): string | null {
  if (typeof text !== 'string') return null;
  let t = text.trim();

  // 优先解析 markdown 代码块里的内容
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    t = fence[1].trim();
  }

  const first = t.indexOf(open);
  const last = t.lastIndexOf(close);
  if (first < 0 || last < 0 || last < first) return null;
  return t.slice(first, last + 1);
}

/**
 * 安全的 JSON 解析，失败返回 null。
 */
export function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 安全的 JSON 文件读取，失败返回 null。
 */
export function safeReadJsonFile<T>(readFile: () => string): T | null {
  try {
    const raw = readFile();
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
