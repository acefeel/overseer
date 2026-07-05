import type { AppConfig, ProviderConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { getTracker } from '../budget/tracker.js';
import type {
  ChatRequest,
  ChatResponse,
  QuotaStatus,
} from './base.js';
import type { Provider as IProvider, ProviderRole } from './base.js';
import { ProviderError } from './base.js';
import { GlmProvider } from './glm.js';
import { OpenAICompatProvider } from './openai-compat.js';

interface FactoryOut extends IProvider {}
type Factory = (id: string, cfg: ProviderConfig) => FactoryOut;

const FACTORY: Record<string, Factory> = {
  glm: (id, cfg) => new GlmProvider(id, cfg),
  openai: (id, cfg) => new OpenAICompatProvider(id, cfg, { kind: 'openai' }),
  deepseek: (id, cfg) => new OpenAICompatProvider(id, cfg, { kind: 'deepseek' }),
  anthropic: (id, cfg) => new OpenAICompatProvider(id, cfg, { kind: 'anthropic' }),
  local: (id, cfg) =>
    new OpenAICompatProvider(id, cfg, {
      kind: 'local',
      role: cfg.role === 'fallback' ? 'fallback' : 'main',
    }),
};

export class Router {
  private providers = new Map<string, IProvider>();
  private chain: string[];
  private fallbackId?: string;
  private taskRouting: Record<string, string>;
  private log = getLogger('router');

  constructor(cfg: AppConfig) {
    this.taskRouting = { ...cfg.router.taskRouting };
    for (const [id, pcfg] of Object.entries(cfg.providers)) {
      if (!pcfg.enabled) continue;
      const factory = FACTORY[pcfg.kind];
      if (!factory) {
        this.log.warn({ id, kind: pcfg.kind }, 'unknown provider kind, skipping');
        continue;
      }
      this.providers.set(id, factory(id, pcfg));
    }
    const chain = cfg.router.chain.filter((id) => this.providers.has(id));
    if (chain.length === 0 && this.providers.size > 0) {
      chain.push([...this.providers.keys()][0]);
    }
    this.chain = chain;

    const fb = cfg.router.fallback;
    if (fb && this.providers.has(fb)) {
      const p = this.providers.get(fb)!;
      if (p.role === 'fallback') {
        this.fallbackId = fb;
      } else {
        this.log.warn(
          { id: fb, role: p.role },
          'configured router.fallback must have role:fallback; ignoring'
        );
      }
    }

    this.log.info(
      { chain: this.chain, fallback: this.fallbackId ?? null, all: [...this.providers.keys()] },
      'router initialized'
    );
  }

  get activeChain(): string[] {
    return [...this.chain];
  }

  get fallbackProviderId(): string | undefined {
    return this.fallbackId;
  }

  hasFallback(): boolean {
    return !!this.fallbackId && !!this.providers.get(this.fallbackId)?.isReady();
  }

  /** 主链里至少一个 provider 处于 ready 状态 */
  mainChainReady(): boolean {
    for (const id of this.chain) {
      const p = this.providers.get(id);
      if (p?.isReady()) return true;
    }
    return false;
  }

  // ---- worker / consultant 角色抽象（M5：本地 worker + 远程 consultant） ----

  /** worker = 默认干活的 provider。优先 fallback（本地，免费），其次主链 */
  getWorkerProvider(): IProvider | undefined {
    const fb = this.getFallbackProvider();
    if (fb) return fb;
    for (const id of this.chain) {
      const p = this.providers.get(id);
      if (p?.isReady()) return p;
    }
    return undefined;
  }

  /** consultant = 咨询/升级用的 provider。优先主链（GLM 等"更聪明"的），其次 worker */
  getConsultantProvider(): IProvider | undefined {
    for (const id of this.chain) {
      const p = this.providers.get(id);
      if (p?.isReady()) return p;
    }
    return this.getFallbackProvider();
  }

  /** worker 是否可用（决定能否跑 task loop） */
  hasWorker(): boolean {
    return !!this.getWorkerProvider();
  }

  /** consultant 是否可用（决定能否做 milestone 检查 / 升级） */
  hasConsultant(): boolean {
    return !!this.getConsultantProvider();
  }

  /** 用 worker 跑一次 chat，同样记录指标 */
  async chatViaWorker(req: ChatRequest): Promise<ChatResponse & { providerId: string }> {
    const p = this.getWorkerProvider();
    if (!p) throw new ProviderError('no worker provider available', 'router');
    const task = req.task ?? 'worker';
    const models = this.modelsToTry(p, req.model);
    const attemptedModels: string[] = [];
    let lastErr: ProviderError | null = null;
    for (const model of models) {
      const t0 = Date.now();
      attemptedModels.push(model);
      try {
        const res = await p.chat({ ...req, model });
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model: res.model ?? model,
          task,
          latencyMs: Date.now() - t0,
          ok: true,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
        return { ...res, providerId: p.id };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), p.id, undefined, e);
        lastErr = err;
        this.log.warn({ id: p.id, model, err: err.message }, 'worker model failed, trying fallback model');
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model,
          task,
          latencyMs: Date.now() - t0,
          ok: false,
          statusCode: err.statusCode,
          error: err.message,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
      }
    }
    throw lastErr ?? new ProviderError('worker chat failed', 'router');
  }

  /** 用 consultant 跑一次 chat，同样记录指标 */
  async chatViaConsultant(req: ChatRequest): Promise<ChatResponse & { providerId: string }> {
    const p = this.getConsultantProvider();
    if (!p) throw new ProviderError('no consultant provider available', 'router');
    const task = req.task ?? 'consultant';
    const models = this.modelsToTry(p, req.model);
    const attemptedModels: string[] = [];
    let lastErr: ProviderError | null = null;
    for (const model of models) {
      const t0 = Date.now();
      attemptedModels.push(model);
      try {
        const res = await p.chat({ ...req, model });
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model: res.model ?? model,
          task,
          latencyMs: Date.now() - t0,
          ok: true,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
        return { ...res, providerId: p.id };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), p.id, undefined, e);
        lastErr = err;
        this.log.warn({ id: p.id, model, err: err.message }, 'consultant model failed, trying fallback model');
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model,
          task,
          latencyMs: Date.now() - t0,
          ok: false,
          statusCode: err.statusCode,
          error: err.message,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
      }
    }
    throw lastErr ?? new ProviderError('consultant chat failed', 'router');
  }

  getFallbackProvider(): IProvider | undefined {
    if (!this.fallbackId) return undefined;
    const p = this.providers.get(this.fallbackId);
    return p?.isReady() ? p : undefined;
  }

  getProvider(id: string): IProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): {
    id: string;
    kind: string;
    role: ProviderRole;
    ready: boolean;
    model: string;
    canAct: boolean;
  }[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      role: p.role,
      ready: p.isReady(),
      model: p.defaultModel,
      canAct: p.canAct,
    }));
  }

  pickForTask(task?: string): IProvider | undefined {
    if (task) {
      const cfg = this.lookupTaskRouting(task);
      if (cfg) {
        const p = this.providers.get(cfg);
        if (p?.isReady()) return p;
      }
    }
    for (const id of this.chain) {
      const p = this.providers.get(id);
      if (p?.isReady()) return p;
    }
    return undefined;
  }

  /** 主控链路由。chat() 走这条，按 chain failover，并优先按 task 路由。 */
  async chat(req: ChatRequest): Promise<ChatResponse & { providerId: string }> {
    const task = req.task ?? 'chat';
    const preferred = this.pickForTask(task);
    // 构建尝试顺序：task 偏好的优先，然后 chain 里剩余的
    const order = new Set<string>();
    if (preferred && this.chain.includes(preferred.id)) order.add(preferred.id);
    for (const id of this.chain) order.add(id);

    const tried: string[] = [];
    let lastErr: ProviderError | null = null;
    let retryCount = 0;
    const attemptedModels: string[] = [];

    for (const id of order) {
      const p = this.providers.get(id);
      if (!p || !p.isReady()) continue;

      const models = this.modelsToTry(p, req.model);
      for (const model of models) {
        const t0 = Date.now();
        tried.push(`${id}:${model}`);
        attemptedModels.push(model);
        retryCount++;
        try {
          const res = await p.chat({ ...req, model });
          const latencyMs = Date.now() - t0;
          getTracker().recordMetric({
            ts: new Date().toISOString(),
            provider: id,
            model: res.model ?? model,
            task,
            latencyMs,
            ok: true,
            retryCount: retryCount - 1,
            attemptedModels,
          });
          return { ...res, providerId: id };
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError(String(e), id, undefined, e);
          lastErr = err;
          this.log.warn({ id, model, err: err.message }, 'provider/model failed, trying next');
          getTracker().recordMetric({
            ts: new Date().toISOString(),
            provider: id,
            model,
            task,
            latencyMs: Date.now() - t0,
            ok: false,
            statusCode: err.statusCode,
            error: err.message,
            retryCount: retryCount - 1,
            attemptedModels,
          });
        }
      }
    }
    throw new ProviderError(
      `all main providers exhausted (tried: ${tried.join(', ') || 'none'}). last=${
        lastErr?.message ?? 'unknown'
      }`,
      'router',
      undefined,
      lastErr ?? undefined
    );
  }

  private modelsToTry(p: IProvider, reqModel?: string): string[] {
    const models = new Set<string>();
    if (reqModel) models.add(reqModel);
    models.add(p.defaultModel);
    for (const m of p.config.fallbackModels ?? []) models.add(m);
    return [...models];
  }

  /** 降级模式：直接走 fallback provider，不走主链。同样记录指标与 fallbackModels。 */
  async chatViaFallback(req: ChatRequest): Promise<ChatResponse & { providerId: string }> {
    const p = this.getFallbackProvider();
    if (!p) {
      throw new ProviderError('no fallback provider available for degraded mode', 'router');
    }
    const task = req.task ?? 'fallback';
    const models = this.modelsToTry(p, req.model);
    const attemptedModels: string[] = [];
    let lastErr: ProviderError | null = null;
    for (const model of models) {
      const t0 = Date.now();
      attemptedModels.push(model);
      try {
        const res = await p.chat({ ...req, model });
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model: res.model ?? model,
          task,
          latencyMs: Date.now() - t0,
          ok: true,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
        return { ...res, providerId: p.id };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), p.id, undefined, e);
        lastErr = err;
        this.log.warn({ id: p.id, model, err: err.message }, 'fallback model failed');
        getTracker().recordMetric({
          ts: new Date().toISOString(),
          provider: p.id,
          model,
          task,
          latencyMs: Date.now() - t0,
          ok: false,
          statusCode: err.statusCode,
          error: err.message,
          retryCount: attemptedModels.length - 1,
          attemptedModels,
        });
      }
    }
    throw lastErr ?? new ProviderError('fallback chat failed', 'router');
  }

  async gatherQuotas(): Promise<QuotaStatus[]> {
    const out: QuotaStatus[] = [];
    for (const p of this.providers.values()) {
      if (p.fetchQuota) {
        try {
          out.push(await p.fetchQuota());
        } catch (e) {
          this.log.warn({ id: p.id, err: String(e) }, 'quota fetch failed');
        }
      }
    }
    return out;
  }

  private lookupTaskRouting(task: string): string | undefined {
    return this.taskRouting[task];
  }
}
