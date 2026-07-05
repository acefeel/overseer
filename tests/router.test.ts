import { describe, it, expect } from 'vitest';
import { Router } from '../src/providers/router.js';
import { loadConfig } from '../src/util/config.js';

describe('Router', () => {
  it('主链 ready 时 chat 走 taskRouting', async () => {
    const cfg = loadConfig();
    const router = new Router(cfg);
    // 不实际调用 LLM，只验证 pickForTask 行为
    const p = router.pickForTask('chat');
    expect(p).toBeDefined();
    expect(p?.id).toBe('glm');
  });

  it('fallbackModels 列表非空', () => {
    const cfg = loadConfig();
    const router = new Router(cfg);
    const glm = router.getProvider('glm');
    expect(glm?.config.fallbackModels.length).toBeGreaterThan(0);
  });

  it('本地 fallback 被识别', () => {
    const cfg = loadConfig();
    const router = new Router(cfg);
    expect(router.hasFallback()).toBe(true);
    expect(router.fallbackProviderId).toBe('local');
  });

  it('worker 优先 fallback', () => {
    const cfg = loadConfig();
    const router = new Router(cfg);
    const worker = router.getWorkerProvider();
    expect(worker).toBeDefined();
    expect(worker?.id).toBe('local');
  });

  it('consultant 优先主链', () => {
    const cfg = loadConfig();
    const router = new Router(cfg);
    const consultant = router.getConsultantProvider();
    expect(consultant).toBeDefined();
    expect(consultant?.id).toBe('glm');
  });
});
