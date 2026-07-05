import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Provider,
  ProviderRole,
  QuotaStatus,
  TokenUsage,
} from './base.js';
import { ProviderError, estimateTokensByHeuristic } from './base.js';
import type { ProviderConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';

interface OpenAIChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}
interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string; message?: string };
}

/**
 * OpenAI 兼容协议 provider。可用于：
 * - 本地 Ollama (`http://localhost:11434/v1`, 任意 apiKey)
 * - 本地 LM Studio (`http://localhost:1234/v1`)
 * - llama.cpp server (`http://localhost:8080/v1`)
 * - 远程 OpenAI / DeepSeek / Together 等
 *
 * 角色由构造选项 `role` 决定。fallback 角色不再强制 `canAct=false`，
 * 可作为本地 worker 执行动作；具体安全约束由 ModePolicy / ProjectManifest / approvals 负责。
 */
export class OpenAICompatProvider implements Provider {
  readonly kind: string;
  readonly role: ProviderRole;
  readonly canAct: boolean;
  readonly defaultModel: string;
  private log;

  constructor(
    public readonly id: string,
    public readonly config: ProviderConfig,
    opts: { role?: ProviderRole; kind?: string } = {}
  ) {
    this.kind = opts.kind ?? 'openai-compat';
    this.role = opts.role ?? 'main';
    // M5 设计：fallback 可作为本地 worker 执行动作。
    // canAct 保留为 true；安全由 ProjectManifest / snapshot / approvals 兜底。
    this.canAct = true;
    this.defaultModel = config.model;
    this.log = getLogger(`provider:${this.kind}:${this.id}`);
  }

  isReady(): boolean {
    if (!this.config.enabled) return false;
    if (!this.config.baseUrl) return false;
    return true;
  }

  private authHeader(): string {
    return `Bearer ${this.config.apiKey || 'none'}`;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isReady()) {
      throw new ProviderError(
        `provider ${this.id} not ready (disabled or missing baseUrl)`,
        this.id
      );
    }
    const model = req.model ?? this.defaultModel;
    const body = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: req.temperature ?? 0.7,
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      stream: false,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);
    try {
      this.log.debug({ model, msgCount: req.messages.length }, 'chat request');
      const res = await fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `${this.kind} HTTP ${res.status}: ${text.slice(0, 500)}`,
          this.id,
          res.status
        );
      }
      const data = (await res.json()) as OpenAIResponse;
      if (data.error) {
        throw new ProviderError(
          `${this.kind} error ${data.error.code}: ${data.error.message}`,
          this.id
        );
      }
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      const usage: TokenUsage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens:
          data.usage?.total_tokens ??
          (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
      };
      this.log.info(
        { model, in: usage.promptTokens, out: usage.completionTokens, role: this.role },
        'chat done'
      );
      return { text, model: data.model ?? model, usage, raw: data };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new ProviderError(`${this.kind} timeout after ${this.config.timeout}ms`, this.id);
      }
      throw new ProviderError(
        `${this.kind} fetch failed: ${(e as Error).message}`,
        this.id,
        undefined,
        e
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async countTokens(messages: ChatMessage[], _model?: string): Promise<number> {
    return estimateTokensByHeuristic(messages);
  }

  async fetchQuota(): Promise<QuotaStatus> {
    return {
      provider: this.id,
      source: 'estimated',
      fetchedAt: new Date().toISOString(),
    };
  }
}
