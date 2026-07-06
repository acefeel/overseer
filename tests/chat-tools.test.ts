import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatRequest } from '../src/providers/base.js';
import { ChatToolRouter, type ChatToolContext } from '../src/supervisor/chat-tools.js';

function mockRouter(responseText: string) {
  return {
    chat: vi.fn(async (_req: ChatRequest) => ({
      text: responseText,
      model: 'mock',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      providerId: 'mock',
    })),
  } as any;
}

function mockContext(overrides: Partial<ChatToolContext> = {}): ChatToolContext {
  return {
    status: vi.fn(() => ({ mode: 'normal' })),
    mode: () => 'normal',
    budgetCanRunTask: () => ({ ok: true }),
    modeCanPerform: () => ({ ok: true }),
    pauseTaskLoop: vi.fn(async () => {}),
    resumeTaskLoop: vi.fn(),
    runCycle: vi.fn(async () => ({ mode: 'normal' } as any)),
    scanProject: vi.fn(async () => ({ seeds: [] } as any)),
    listQueue: vi.fn(() => []),
    showQueue: vi.fn(() => null),
    dropQueue: vi.fn(() => true),
    clearQueue: vi.fn(() => 0),
    queueStats: vi.fn(() => ({ total: 0, byStatus: {}, bySeverity: {}, byProject: {}, bySource: {} })),
    listApprovals: vi.fn(() => []),
    decideApproval: vi.fn(async () => null),
    planProject: vi.fn(async () => ({})),
    developIntention: vi.fn(async () => ({})),
    searchKb: vi.fn(() => []),
    recentKb: vi.fn(() => []),
    listProjects: vi.fn(() => []),
    showProject: vi.fn(() => null),
    updateAutonomyConfig: vi.fn(),
    ...overrides,
  };
}

describe('ChatToolRouter', () => {
  it('列出所有工具', () => {
    const router = new ChatToolRouter(mockRouter(''));
    const tools = router.listTools();
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.map((t) => t.name)).toContain('status');
    expect(tools.map((t) => t.name)).toContain('queue.list');
    expect(tools.map((t) => t.name)).toContain('taskloop.pause');
  });

  it('正常模式通过 LLM 识别 status 意图', async () => {
    const resText = JSON.stringify({ tool: 'status', args: {}, summary: '查看当前状态' });
    const router = new ChatToolRouter(mockRouter(resText));
    const req = await router.recognize('看看状态', 'normal');
    expect(req.tool).toBe('status');
    expect(req.needsConfirm).toBe(false);
  });

  it('正常模式 LLM 返回 chat 兜底', async () => {
    const resText = JSON.stringify({ tool: 'chat', args: {}, summary: '', reply: '你好' });
    const router = new ChatToolRouter(mockRouter(resText));
    const req = await router.recognize('你好', 'normal');
    expect(req.tool).toBe('chat');
    expect(req.reply).toBe('你好');
  });

  it('解析失败时回退到 chat', async () => {
    const router = new ChatToolRouter(mockRouter('这不是 JSON'));
    const req = await router.recognize('随便说说', 'normal');
    expect(req.tool).toBe('chat');
    expect(req.reply).toContain('没理解');
  });

  it('高风险操作需要确认（normal 级别）', async () => {
    const resText = JSON.stringify({
      tool: 'supervise.develop',
      args: { id: 'int-1', execute: true },
      summary: '执行 develop',
    });
    const router = new ChatToolRouter(mockRouter(resText));
    const req = await router.recognize('执行意向 int-1', 'normal');
    expect(req.tool).toBe('supervise.develop');
    expect(req.needsConfirm).toBe(true);
  });

  it('paranoid 级别让低风险写操作也确认', async () => {
    const resText = JSON.stringify({
      tool: 'queue.drop',
      args: { id: 'q-123' },
      summary: '删除队列项',
    });
    const router = new ChatToolRouter(mockRouter(resText), { confirmLevel: 'paranoid' });
    const req = await router.recognize('删除 q-123', 'normal');
    expect(req.needsConfirm).toBe(true);
  });

  it('none 级别不确认高风险操作', async () => {
    const resText = JSON.stringify({
      tool: 'queue.clear',
      args: {},
      summary: '清空队列',
    });
    const router = new ChatToolRouter(mockRouter(resText), { confirmLevel: 'none' });
    const req = await router.recognize('清空队列', 'normal');
    expect(req.tool).toBe('queue.clear');
    expect(req.needsConfirm).toBe(false);
  });

  it('降级模式规则匹配状态', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const req = await router.recognize('查看状态', 'degraded');
    expect(req.tool).toBe('status');
  });

  it('降级模式规则匹配暂停', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const req = await router.recognize('暂停任务循环', 'degraded');
    expect(req.tool).toBe('taskloop.pause');
  });

  it('降级模式禁用复杂意图', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const req = await router.recognize('给 overSeer 生成 plan', 'degraded');
    expect(req.tool).toBe('chat');
    expect(req.reply).toContain('normal 模式');
  });

  it('stopped 模式返回提示', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const req = await router.recognize('查看状态', 'stopped');
    expect(req.tool).toBe('chat');
    expect(req.reply).toContain('stopped 模式');
  });

  it('执行 status 工具', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext();
    const res = await router.execute(ctx, 'status', {});
    expect(res.ok).toBe(true);
    expect(res.tool).toBe('status');
    expect(ctx.status).toHaveBeenCalled();
  });

  it('执行 queue.drop 工具', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext();
    const res = await router.execute(ctx, 'queue.drop', { id: 'q-1' });
    expect(res.ok).toBe(true);
    expect(ctx.dropQueue).toHaveBeenCalledWith('q-1');
  });

  it('执行 taskloop.pause 工具', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext();
    const res = await router.execute(ctx, 'taskloop.pause', {});
    expect(res.ok).toBe(true);
    expect(ctx.pauseTaskLoop).toHaveBeenCalled();
  });

  it('allowActions=false 拒绝写操作', async () => {
    const router = new ChatToolRouter(mockRouter(''), { allowActions: false });
    const ctx = mockContext();
    const res = await router.execute(ctx, 'queue.drop', { id: 'q-1' });
    expect(res.ok).toBe(false);
    expect(ctx.dropQueue).not.toHaveBeenCalled();
  });

  it('未知工具返回错误', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext();
    const res = await router.execute(ctx, 'not.exists', {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('未知工具');
  });

  it('supervise.develop 在 stopped 模式被拒绝', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext({
      mode: () => 'stopped',
      modeCanPerform: () => ({ ok: false, reason: 'stopped mode: no LLM actions allowed' }),
    });
    const res = await router.execute(ctx, 'supervise.develop', { id: 'int-1', execute: false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('stopped');
  });

  it('supervise.plan 在 normal 模式但 budget 不足被拒绝', async () => {
    const router = new ChatToolRouter(mockRouter(''));
    const ctx = mockContext({ budgetCanRunTask: () => ({ ok: false, reason: 'budget exhausted' }) });
    const res = await router.execute(ctx, 'supervise.plan', { project: 'overSeer' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('budget exhausted');
  });

  it('总结工具结果调用 LLM', async () => {
    const summary = '当前状态正常';
    const router = new ChatToolRouter(mockRouter(summary));
    const text = await router.summarize('看看状态', { ok: true, tool: 'status', data: { mode: 'normal' } });
    expect(text).toBe(summary);
  });
});
