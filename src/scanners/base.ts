import type { ProjectInfo } from '../projects/scanner.js';

/**
 * 扫描器产出的"意向种子"。会比 LLM plan 产出的 Intention 更轻量；
 * 由 queue 进一步合并/升华（可选调 LLM 加 rationale 后再入主队列）。
 */
export interface IntentionSeed {
  /** 同 project+source+key 视为同一条（用于去重） */
  key: string;
  project: string;
  source: ScannerId;
  category:
    | 'bug'
    | 'tech-debt'
    | 'feature'
    | 'test'
    | 'docs'
    | 'refactor'
    | 'security'
    | 'perf'
    | 'hygiene';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  detail: string;
  /** 建议的下一步动作（写入 proposedAction 之前） */
  hint?: string;
  /** 关联文件（用于 LLM 上下文 + 检索） */
  files?: string[];
  /** 扫描时刻 */
  detectedAt: string;
}

export type ScannerId =
  | 'git'
  | 'todo'
  | 'outdated'
  | 'test'
  | 'lint'
  | 'manual'
  | 'llm-plan';

export interface ScannerContext {
  project: ProjectInfo;
  /** 是否允许执行 shell（npm outdated / test 都需要）；false 时这些 scanner 自行 skip */
  allowShell: boolean;
  /** 限速：单 scanner 在一个 project 上最多返回几条 */
  limitPerScanner: number;
}

export interface Scanner {
  readonly id: ScannerId;
  readonly description: string;
  /** 真实成本：cheap=read-only fs；medium=spawn 1 个 git/npm；expensive=跑测试 */
  readonly cost: 'cheap' | 'medium' | 'expensive';
  scan(ctx: ScannerContext): Promise<IntentionSeed[]>;
}

export function nowIso(): string {
  return new Date().toISOString();
}
