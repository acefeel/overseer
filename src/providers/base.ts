import type { ProviderConfig } from '../util/config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  task?: 'chat' | 'planning' | 'embedding' | 'summary' | 'chat-tools';
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage: TokenUsage;
  raw?: unknown;
}

export interface QuotaStatus {
  provider: string;
  remainingTokens?: number;
  remainingRequests?: number;
  resetAt?: string;
  source: 'api' | 'estimated';
  fetchedAt: string;
}

/**
 * Provider 在系统中的角色：
 * - main：主控，可执行有副作用的动作
 * - fallback：降级回退或本地 worker。是否可执行副作用动作由 `canAct` 字段决定，
 *   不再在角色层强制禁止。
 */
export type ProviderRole = 'main' | 'fallback';

export interface Provider {
  readonly id: string;
  readonly kind: string;
  readonly defaultModel: string;
  readonly config: ProviderConfig;
  /** 主控 / 降级回退 */
  readonly role: ProviderRole;
  /**
   * 是否允许执行有副作用的动作（写文件、commit、shell exec）。
   *
   * M5 设计：fallback 也可以作为本地 worker 执行动作，因此当前实现为 `true`。
   * 安全兜底由 ProjectManifest.protectedPaths、ActionExecutor 的自动 snapshot、
   * approvals 审批共同承担。保留这个字段是为了将来想启用“严格只读 fallback”
   * 时还能切回。
   */
  readonly canAct: boolean;
  isReady(): boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  countTokens(messages: ChatMessage[], model?: string): Promise<number>;
  fetchQuota?(): Promise<QuotaStatus>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function estimateTokensByHeuristic(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.role.length + 4) + (m.content?.length ?? 0);
    if (m.name) chars += m.name.length;
  }
  return Math.ceil(chars / 3.5);
}
