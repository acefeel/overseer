import { describe, it, expect } from 'vitest';
import { HealthProbe } from '../src/providers/health.js';
import type { AppConfig, ProviderConfig } from '../src/util/config.js';

function cfg(providers: Record<string, ProviderConfig>): AppConfig {
  return {
    providers,
    router: { chain: [], fallback: undefined, taskRouting: {} },
  } as AppConfig;
}

describe('HealthProbe.extractModels via probe', () => {
  it('OpenAI /models 格式：{ data: [{ id: ... }] }', async () => {
    const probe = new HealthProbe(cfg({
      openai: {
        enabled: true,
        kind: 'openai',
        baseUrl: 'http://localhost:1',
        apiKey: 'x',
        model: 'gpt-4o',
      } as ProviderConfig,
    }));

    const models = (probe as any).extractModels('openai', { kind: 'openai' } as ProviderConfig, {
      object: 'list',
      data: [{ id: 'gpt-4o', object: 'model' }, { id: 'gpt-4o-mini' }],
    });
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('Ollama /api/tags 格式：{ models: [{ name: ... }] }', async () => {
    const probe = new HealthProbe(cfg({}));
    const models = (probe as any).extractModels('local', { kind: 'local' } as ProviderConfig, {
      models: [{ name: 'gemma4:latest', modified_at: '2024-01-01' }],
    });
    expect(models).toEqual(['gemma4:latest']);
  });

  it('兼容只有字符串数组的返回', () => {
    const probe = new HealthProbe(cfg({}));
    const models = (probe as any).extractModels('x', { kind: 'openai' } as ProviderConfig, {
      models: ['llama3', 'mistral'],
    });
    expect(models).toEqual(['llama3', 'mistral']);
  });

  it('空/损坏数据返回 undefined', () => {
    const probe = new HealthProbe(cfg({}));
    expect((probe as any).extractModels('x', { kind: 'openai' } as ProviderConfig, null)).toBeUndefined();
    expect((probe as any).extractModels('x', { kind: 'openai' } as ProviderConfig, {})).toBeUndefined();
    expect((probe as any).extractModels('x', { kind: 'openai' } as ProviderConfig, { data: [] })).toBeUndefined();
  });

  it('models 数量上限 50', () => {
    const probe = new HealthProbe(cfg({}));
    const data = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` }));
    const models = (probe as any).extractModels('x', { kind: 'openai' } as ProviderConfig, { data });
    expect(models?.length).toBe(50);
  });
});

describe('HealthProbe.modelsUrl', () => {
  it('local 用 /api/tags', () => {
    const probe = new HealthProbe(cfg({}));
    const url = (probe as any).modelsUrl('local', { kind: 'local' } as ProviderConfig, 'http://localhost:11434/v1');
    expect(url).toBe('http://localhost:11434/api/tags');
  });

  it('远程 openai 用 /models', () => {
    const probe = new HealthProbe(cfg({}));
    const url = (probe as any).modelsUrl('openai', { kind: 'openai' } as ProviderConfig, 'https://api.openai.com/v1');
    expect(url).toBe('https://api.openai.com/v1/models');
  });
});
