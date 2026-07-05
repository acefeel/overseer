import { getLogger } from '../util/logger.js';
import type { AppConfig, ProviderConfig } from '../util/config.js';

export interface ProviderHealth {
  id: string;
  ready: boolean;
  /** 通过简单 ping 检测真实可达性（不调用 LLM） */
  reachable: boolean;
  /** 已加载模型列表（Ollama / OpenAI 兼容） */
  models?: string[];
  latencyMs?: number;
  lastCheckedAt: string;
  error?: string;
}

/**
 * provider 健康探测。专门为 fallback (Ollama) 设计：
 * 不调 LLM，只调 `/api/tags`（Ollama）或 `/models`（OpenAI 兼容）。
 *
 * ModePolicy 决定是否进入 degraded 时不再只看 isReady()（配置层），
 * 而是看 reachability（运行层），避免"切到本地却发现 Ollama 没起"。
 */
export class HealthProbe {
  private log = getLogger('health');
  private cache = new Map<string, { h: ProviderHealth; ts: number }>();
  private ttlMs: number;

  constructor(private readonly cfg: AppConfig, ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  async checkProvider(id: string, force = false): Promise<ProviderHealth> {
    const cached = this.cache.get(id);
    const now = Date.now();
    if (!force && cached && now - cached.ts < this.ttlMs) {
      return cached.h;
    }
    const pcfg = this.cfg.providers[id];
    const h = pcfg ? await this.probe(id, pcfg) : this.unknown(id, 'provider not configured');
    this.cache.set(id, { h, ts: now });
    return h;
  }

  async checkAll(): Promise<ProviderHealth[]> {
    const out: ProviderHealth[] = [];
    for (const id of Object.keys(this.cfg.providers)) {
      out.push(await this.checkProvider(id));
    }
    return out;
  }

  /** 当前 fallback 是否真的能服务（配置 ready + 网络 reachable） */
  async fallbackUsable(): Promise<boolean> {
    const fb = this.cfg.router.fallback;
    if (!fb) return false;
    const pcfg = this.cfg.providers[fb];
    if (!pcfg?.enabled) return false;
    const h = await this.checkProvider(fb);
    return h.reachable;
  }

  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private async probe(id: string, pcfg: ProviderConfig): Promise<ProviderHealth> {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const base = pcfg.baseUrl.replace(/\/$/, '');
    const url = this.modelsUrl(id, pcfg, base);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${pcfg.apiKey || 'none'}` },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return this.make(id, pcfg, false, latencyMs, `HTTP ${res.status}`);
      }
      const data: unknown = await res.json().catch(() => null);
      const models = this.extractModels(id, pcfg, data);
      return this.make(id, pcfg, true, latencyMs, undefined, models);
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = (e as Error).name === 'AbortError' ? 'timeout (5000ms)' : (e as Error).message;
      return this.make(id, pcfg, false, latencyMs, msg);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 统一模型列表提取。
   * 覆盖 OpenAI 兼容 `/models` 与 Ollama `/api/tags` 两种常见格式，
   * 并尽量兼容只返回字符串数组的服务端。
   */
  private extractModels(id: string, pcfg: ProviderConfig, data: unknown): string[] | undefined {
    if (!data || typeof data !== 'object') return undefined;

    const candidates: any[] = [];

    // OpenAI 兼容：{ data: [{ id: '...' }, ...] }
    if (Array.isArray((data as any).data)) candidates.push(...(data as any).data);
    // Ollama /api/tags：{ models: [{ name: '...' }, ...] }
    if (Array.isArray((data as any).models)) candidates.push(...(data as any).models);

    // 兜底：如果对象本身只有一层数组字段，也尝试
    if (candidates.length === 0) {
      for (const v of Object.values(data as Record<string, unknown>)) {
        if (Array.isArray(v) && v.length > 0) {
          candidates.push(...v);
          break;
        }
      }
    }

    if (candidates.length === 0) return undefined;

    const models = candidates
      .map((m: any) => {
        if (typeof m === 'string') return m;
        if (m && typeof m === 'object') {
          // OpenAI: id, object, created, owned_by
          // Ollama: name, model, modified_at, digest
          return m.id ?? m.name ?? m.model ?? String(m);
        }
        return String(m);
      })
      .filter(Boolean)
      .slice(0, 50);

    this.log.debug({ id, kind: pcfg.kind, count: models.length }, 'extracted model list');
    return models.length > 0 ? models : undefined;
  }

  private modelsUrl(id: string, pcfg: ProviderConfig, base: string): string {
    // Ollama OpenAI 兼容端点同时支持 /models，但为了获得更完整信息也可用 /api/tags
    if (pcfg.kind === 'local') {
      const ollamaBase = base.replace(/\/v1$/, '');
      const tagsUrl = `${ollamaBase}/api/tags`;
      this.log.debug({ id, tagsUrl }, 'using Ollama /api/tags for health');
      return tagsUrl;
    }
    return `${base}/models`;
  }

  private make(
    id: string,
    pcfg: ProviderConfig,
    reachable: boolean,
    latencyMs: number,
    error?: string,
    models?: string[]
  ): ProviderHealth {
    const h: ProviderHealth = {
      id,
      ready: pcfg.enabled && !!pcfg.apiKey,
      reachable,
      latencyMs,
      lastCheckedAt: new Date().toISOString(),
      error,
      ...(models ? { models } : {}),
    };
    if (reachable) {
      this.log.debug({ id, latencyMs, models: models?.length }, 'provider healthy');
    } else {
      this.log.warn({ id, err: error }, 'provider unreachable');
    }
    return h;
  }

  private unknown(id: string, error: string): ProviderHealth {
    return {
      id,
      ready: false,
      reachable: false,
      lastCheckedAt: new Date().toISOString(),
      error,
    };
  }
}
