import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  Provider,
  QuotaStatus,
  TokenUsage,
} from './base.js';
import { ProviderError, estimateTokensByHeuristic } from './base.js';
import type { ProviderConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';

interface BigModelChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}
interface BigModelResponse {
  id?: string;
  model?: string;
  choices?: BigModelChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: string; message?: string };
}

export class GlmProvider implements Provider {
  readonly kind = 'glm';
  readonly role = 'main' as const;
  readonly canAct = true;
  readonly defaultModel: string;
  private log;
  constructor(
    public readonly id: string,
    public readonly config: ProviderConfig
  ) {
    this.defaultModel = config.model;
    this.log = getLogger(`provider:glm:${this.id}`);
  }

  isReady(): boolean {
    return this.config.enabled && !!this.config.apiKey && this.config.apiKey.length > 0;
  }

  private authHeader(): string {
    return `Bearer ${this.config.apiKey}`;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.isReady()) {
      throw new ProviderError(
        `provider ${this.id} not ready (missing apiKey or disabled)`,
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
      this.log.debug({ model, msgCount: req.messages.length }, 'GLM chat request');
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
          `GLM HTTP ${res.status}: ${text.slice(0, 500)}`,
          this.id,
          res.status
        );
      }
      const data = (await res.json()) as BigModelResponse;
      if (data.error) {
        throw new ProviderError(
          `GLM error ${data.error.code}: ${data.error.message}`,
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
        { model, in: usage.promptTokens, out: usage.completionTokens },
        'GLM chat done'
      );
      return { text, model: data.model ?? model, usage, raw: data };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === 'AbortError') {
        throw new ProviderError(`GLM timeout after ${this.config.timeout}ms`, this.id);
      }
      throw new ProviderError(
        `GLM fetch failed: ${(e as Error).message}`,
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
