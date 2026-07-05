import { describe, it, expect } from 'vitest';
import { extractJsonObject, extractJsonArray, safeParseJson } from '../src/util/json.js';

describe('extractJsonObject', () => {
  it('解析纯 JSON 对象', () => {
    const r = extractJsonObject('{"a":1,"b":"x"}');
    expect(r).toEqual({ a: 1, b: 'x' });
  });

  it('解析 markdown fence 包裹的对象', () => {
    const r = extractJsonObject('```json\n{"a":1}\n```');
    expect(r).toEqual({ a: 1 });
  });

  it('从解释文本中提取对象', () => {
    const r = extractJsonObject('这是结果：\n\n```\n{"ok":true}\n```\n再见');
    expect(r).toEqual({ ok: true });
  });

  it('数组不会被当对象返回', () => {
    const r = extractJsonObject('[1,2,3]');
    expect(r).toBeNull();
  });

  it('非 JSON 返回 null', () => {
    expect(extractJsonObject('not json')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject(null as any)).toBeNull();
  });
});

describe('extractJsonArray', () => {
  it('解析纯 JSON 数组', () => {
    const r = extractJsonArray('[1,2,3]');
    expect(r).toEqual([1, 2, 3]);
  });

  it('解析 fence 里的数组', () => {
    const r = extractJsonArray('```json\n[{"x":1}]\n```');
    expect(r).toEqual([{ x: 1 }]);
  });

  it('对象不会被当数组返回', () => {
    const r = extractJsonArray('{"a":1}');
    expect(r).toBeNull();
  });
});

describe('safeParseJson', () => {
  it('成功解析返回对象', () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('失败返回 null', () => {
    expect(safeParseJson('not json')).toBeNull();
  });
});
