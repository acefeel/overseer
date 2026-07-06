import { z } from 'zod';
import type { SupervisionMode, ActionType } from '../daemon/mode.js';
import type { CycleConfig, CycleOutcome } from './autonomy.js';
import type { ScanResult } from '../scanners/index.js';
import type { QueueItem, QueueItemStatus } from './queue.js';
import type { PendingApproval } from './approvals.js';
import type { NoteType } from '../kb/schema.js';
import type { ProjectInfo } from '../projects/scanner.js';
import { extractJsonObject } from '../util/json.js';
import { getLogger } from '../util/logger.js';
import type { Router } from '../providers/router.js';
import type { ChatRequest } from '../providers/base.js';

export type ToolCategory = 'read' | 'low-risk' | 'medium-risk' | 'high-risk';

export interface ToolResult {
  ok: boolean;
  tool: string;
  data?: unknown;
  error?: string;
}

export interface ToolCallRequest {
  tool: string;
  args: Record<string, unknown>;
  needsConfirm: boolean;
  summary: string;
  /** 当 tool === 'chat' 时，直接返回给用户的回复 */
  reply?: string;
}

export interface AutonomyConfigPatch {
  aggressiveness?: 'light' | 'normal' | 'full';
  limitPerScanner?: number;
  autoExecute?: boolean;
  allowShellDuringScan?: boolean;
  onlyProjects?: string[];
}

export interface ChatToolContext {
  status(): unknown;
  mode(): SupervisionMode;
  budgetCanRunTask(estimated: number): { ok: boolean; reason?: string };
  modeCanPerform(action: ActionType): { ok: boolean; reason?: string };
  pauseTaskLoop(): Promise<void>;
  resumeTaskLoop(): void;
  runCycle(opts: Partial<CycleConfig>): Promise<CycleOutcome>;
  scanProject(projectId: string, opts: Partial<CycleConfig>): Promise<ScanResult>;
  listQueue(opts: { project?: string; status?: QueueItemStatus; limit?: number }): QueueItem[];
  showQueue(id: string): QueueItem | null;
  dropQueue(id: string): boolean;
  clearQueue(project?: string): number;
  queueStats(): {
    total: number;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byProject: Record<string, number>;
    bySource: Record<string, number>;
  };
  listApprovals(pendingOnly?: boolean): PendingApproval[];
  decideApproval(id: string, status: 'approved' | 'rejected'): Promise<PendingApproval | null>;
  planProject(projectId: string, hint?: string): Promise<unknown>;
  developIntention(id: string, execute: boolean): Promise<unknown>;
  searchKb(q: string, limit?: number): unknown[];
  recentKb(limit?: number, type?: NoteType): unknown[];
  listProjects(): ProjectInfo[];
  showProject(id: string): ProjectInfo | null;
  updateAutonomyConfig(updates: AutonomyConfigPatch): void;
}

export type ConfirmLevel = 'paranoid' | 'normal' | 'none';

export interface ChatToolsOptions {
  confirmLevel?: ConfirmLevel;
  allowActions?: boolean;
}

interface ToolDef {
  name: string;
  description: string;
  category: ToolCategory;
  argsSchema: z.ZodObject<any>;
  examples?: string[];
  execute(ctx: ChatToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const EmptyArgs = z.object({});

const StatusArgs = EmptyArgs;
const QueueListArgs = z.object({
  project: z.string().optional(),
  status: z.enum(['pending', 'plan-generated', 'design-generated', 'executing', 'done', 'abandoned']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const QueueIdArgs = z.object({ id: z.string().min(1) });
const QueueClearArgs = z.object({ project: z.string().optional() });
const CycleRunArgs = z.object({
  project: z.string().optional(),
  aggressiveness: z.enum(['light', 'normal', 'full']).optional(),
  autoExecute: z.boolean().default(false),
  allowShell: z.boolean().default(false),
});
const CycleScanArgs = z.object({
  project: z.string().min(1),
  aggressiveness: z.enum(['light', 'normal', 'full']).optional(),
  allowShell: z.boolean().default(false),
});
const PlanArgs = z.object({
  project: z.string().min(1),
  hint: z.string().optional(),
});
const DevelopArgs = z.object({
  id: z.string().min(1),
  execute: z.boolean().default(false),
});
const ApprovalIdArgs = z.object({ id: z.string().min(1) });
const ApprovalListArgs = z.object({ pendingOnly: z.boolean().default(true) });
const KbSearchArgs = z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(20).default(5) });
const KbRecentArgs = z.object({
  type: z.enum(['moc', 'daily', 'adr', 'budget', 'plan', 'design', 'retro', 'knowledge', 'chat_log']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
const ProjectShowArgs = z.object({ id: z.string().min(1) });
const ConfigUpdateArgs = z.object({
  aggressiveness: z.enum(['light', 'normal', 'full']).optional(),
  limitPerScanner: z.coerce.number().int().min(1).max(100).optional(),
  autoExecute: z.boolean().optional(),
  allowShellDuringScan: z.boolean().optional(),
  onlyProjects: z.array(z.string()).optional(),
});

function result(tool: string, data?: unknown, error?: string): ToolResult {
  return error ? { ok: false, tool, error } : { ok: true, tool, data };
}

function checkStopped(ctx: ChatToolContext): ToolResult | null {
  if (ctx.mode() === 'stopped') {
    return {
      ok: false,
      tool: '',
      error: '当前为 stopped 模式（主控不可用且无 fallback），无法执行该操作。',
    };
  }
  return null;
}

function checkMode(ctx: ChatToolContext, action: ActionType, tool: string): ToolResult | null {
  const gate = ctx.modeCanPerform(action);
  if (!gate.ok) {
    return { ok: false, tool, error: gate.reason ?? `mode=${ctx.mode()} 禁止该操作` };
  }
  return null;
}

const STATUS: ToolDef = {
  name: 'status',
  description: '查看 overSeer 当前状态：provider、mode、budget、队列、任务循环等。',
  category: 'read',
  argsSchema: StatusArgs,
  execute: async (ctx) => result('status', ctx.status()),
};

const QUEUE_LIST: ToolDef = {
  name: 'queue.list',
  description: '列出队列中的任务，可按项目、状态、数量过滤。',
  category: 'read',
  argsSchema: QueueListArgs,
  execute: async (ctx, args) => {
    const items = ctx.listQueue(args as any);
    return result('queue.list', { count: items.length, items });
  },
};

const QUEUE_SHOW: ToolDef = {
  name: 'queue.show',
  description: '显示指定队列项的详情。',
  category: 'read',
  argsSchema: QueueIdArgs,
  execute: async (ctx, args) => {
    const item = ctx.showQueue(args.id as string);
    if (!item) return result('queue.show', undefined, `未找到队列项：${args.id}`);
    return result('queue.show', item);
  },
};

const QUEUE_DROP: ToolDef = {
  name: 'queue.drop',
  description: '删除指定的队列项。',
  category: 'medium-risk',
  argsSchema: QueueIdArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'queue.drop' };
    const ok = ctx.dropQueue(args.id as string);
    return result('queue.drop', { dropped: ok }, ok ? undefined : `未找到队列项：${args.id}`);
  },
};

const QUEUE_CLEAR: ToolDef = {
  name: 'queue.clear',
  description: '清空队列；可指定只清空某个项目的队列项。',
  category: 'medium-risk',
  argsSchema: QueueClearArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'queue.clear' };
    const n = ctx.clearQueue(args.project as string | undefined);
    return result('queue.clear', { removed: n });
  },
};

const QUEUE_STATS: ToolDef = {
  name: 'queue.stats',
  description: '队列统计信息。',
  category: 'read',
  argsSchema: EmptyArgs,
  execute: async (ctx) => {
    const s = ctx.queueStats();
    return result('queue.stats', s);
  },
};

const TASKLOOP_PAUSE: ToolDef = {
  name: 'taskloop.pause',
  description: '暂停任务循环。',
  category: 'low-risk',
  argsSchema: EmptyArgs,
  execute: async (ctx) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'taskloop.pause' };
    await ctx.pauseTaskLoop();
    return result('taskloop.pause', { state: 'paused' });
  },
};

const TASKLOOP_RESUME: ToolDef = {
  name: 'taskloop.resume',
  description: '恢复任务循环。',
  category: 'low-risk',
  argsSchema: EmptyArgs,
  execute: async (ctx) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'taskloop.resume' };
    ctx.resumeTaskLoop();
    return result('taskloop.resume', { state: 'running' });
  },
};

const CYCLE_RUN: ToolDef = {
  name: 'cycle.run',
  description: '触发一轮自主巡检扫描项目并入队。',
  category: 'low-risk',
  argsSchema: CycleRunArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'cycle.run' };
    const out = await ctx.runCycle({
      aggressiveness: args.aggressiveness as any,
      autoExecute: args.autoExecute as boolean,
      allowShellDuringScan: args.allowShell as boolean,
      onlyProjects: args.project ? [args.project as string] : [],
    });
    return result('cycle.run', out);
  },
};

const CYCLE_SCAN: ToolDef = {
  name: 'cycle.scan',
  description: '扫描指定项目，不入队，只返回扫描结果。',
  category: 'read',
  argsSchema: CycleScanArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'cycle.scan' };
    const r = await ctx.scanProject(args.project as string, {
      aggressiveness: args.aggressiveness as any,
      allowShellDuringScan: args.allowShell as boolean,
    });
    return result('cycle.scan', r);
  },
};

const SUPERVISE_PLAN: ToolDef = {
  name: 'supervise.plan',
  description: '为指定项目生成候选意向 plan。',
  category: 'low-risk',
  argsSchema: PlanArgs,
  execute: async (ctx, args) => {
    const modeErr = checkMode(ctx, 'plan', 'supervise.plan');
    if (modeErr) return modeErr;
    const budget = ctx.budgetCanRunTask(15000);
    if (!budget.ok) return result('supervise.plan', undefined, budget.reason);
    const out = await ctx.planProject(args.project as string, args.hint as string | undefined);
    return result('supervise.plan', out);
  },
};

const SUPERVISE_DEVELOP: ToolDef = {
  name: 'supervise.develop',
  description: '对指定意向执行 design 或 develop（execute=true 会真正写代码）。',
  category: 'high-risk',
  argsSchema: DevelopArgs,
  execute: async (ctx, args) => {
    const action: ActionType = args.execute ? 'file.write' : 'design';
    const modeErr = checkMode(ctx, action, 'supervise.develop');
    if (modeErr) return modeErr;
    const budget = ctx.budgetCanRunTask(args.execute ? 60000 : 15000);
    if (!budget.ok) return result('supervise.develop', undefined, budget.reason);
    const out = await ctx.developIntention(args.id as string, args.execute as boolean);
    return result('supervise.develop', out);
  },
};

const APPROVALS_LIST: ToolDef = {
  name: 'approvals.list',
  description: '列出待审批或全部审批项。',
  category: 'read',
  argsSchema: ApprovalListArgs,
  execute: async (ctx, args) => {
    const items = ctx.listApprovals(args.pendingOnly as boolean);
    return result('approvals.list', { count: items.length, items });
  },
};

const APPROVALS_APPROVE: ToolDef = {
  name: 'approvals.approve',
  description: '批准指定的审批项。',
  category: 'medium-risk',
  argsSchema: ApprovalIdArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'approvals.approve' };
    const a = await ctx.decideApproval(args.id as string, 'approved');
    if (!a) return result('approvals.approve', undefined, `未找到审批项：${args.id}`);
    return result('approvals.approve', a);
  },
};

const APPROVALS_REJECT: ToolDef = {
  name: 'approvals.reject',
  description: '拒绝指定的审批项。',
  category: 'medium-risk',
  argsSchema: ApprovalIdArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'approvals.reject' };
    const a = await ctx.decideApproval(args.id as string, 'rejected');
    if (!a) return result('approvals.reject', undefined, `未找到审批项：${args.id}`);
    return result('approvals.reject', a);
  },
};

const KB_SEARCH: ToolDef = {
  name: 'kb.search',
  description: '在 vault 中搜索相关知识。',
  category: 'read',
  argsSchema: KbSearchArgs,
  execute: async (ctx, args) => {
    const hits = ctx.searchKb(args.q as string, args.limit as number);
    return result('kb.search', { count: hits.length, hits });
  },
};

const KB_RECENT: ToolDef = {
  name: 'kb.recent',
  description: '查看最近写入 vault 的笔记。',
  category: 'read',
  argsSchema: KbRecentArgs,
  execute: async (ctx, args) => {
    const notes = ctx.recentKb(args.limit as number, args.type as NoteType | undefined);
    return result('kb.recent', { count: notes.length, notes });
  },
};

const PROJECT_LIST: ToolDef = {
  name: 'project.list',
  description: '列出当前 workspace 中被监理的项目。',
  category: 'read',
  argsSchema: EmptyArgs,
  execute: async (ctx) => result('project.list', ctx.listProjects()),
};

const PROJECT_SHOW: ToolDef = {
  name: 'project.show',
  description: '查看指定项目的详情。',
  category: 'read',
  argsSchema: ProjectShowArgs,
  execute: async (ctx, args) => {
    const p = ctx.showProject(args.id as string);
    if (!p) return result('project.show', undefined, `未找到项目：${args.id}`);
    return result('project.show', p);
  },
};

const CONFIG_UPDATE: ToolDef = {
  name: 'config.update',
  description: '更新 autonomy 配置（仅允许 daemon.autonomy 下的字段）。',
  category: 'high-risk',
  argsSchema: ConfigUpdateArgs,
  execute: async (ctx, args) => {
    const stopped = checkStopped(ctx);
    if (stopped) return { ...stopped, tool: 'config.update' };
    const patch: AutonomyConfigPatch = {};
    if (args.aggressiveness !== undefined) patch.aggressiveness = args.aggressiveness as any;
    if (args.limitPerScanner !== undefined) patch.limitPerScanner = args.limitPerScanner as number;
    if (args.autoExecute !== undefined) patch.autoExecute = args.autoExecute as boolean;
    if (args.allowShellDuringScan !== undefined) patch.allowShellDuringScan = args.allowShellDuringScan as boolean;
    if (args.onlyProjects !== undefined) patch.onlyProjects = args.onlyProjects as string[];
    ctx.updateAutonomyConfig(patch);
    return result('config.update', patch);
  },
};

const CHAT: ToolDef = {
  name: 'chat',
  description: '普通聊天，不调用任何工具。',
  category: 'read',
  argsSchema: EmptyArgs,
  execute: async (_ctx, _args) => {
    throw new Error('chat tool should not be executed');
  },
};

const TOOLS: ToolDef[] = [
  STATUS,
  QUEUE_LIST,
  QUEUE_SHOW,
  QUEUE_DROP,
  QUEUE_CLEAR,
  QUEUE_STATS,
  TASKLOOP_PAUSE,
  TASKLOOP_RESUME,
  CYCLE_RUN,
  CYCLE_SCAN,
  SUPERVISE_PLAN,
  SUPERVISE_DEVELOP,
  APPROVALS_LIST,
  APPROVALS_APPROVE,
  APPROVALS_REJECT,
  KB_SEARCH,
  KB_RECENT,
  PROJECT_LIST,
  PROJECT_SHOW,
  CONFIG_UPDATE,
  CHAT,
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function needsConfirm(category: ToolCategory, level: ConfirmLevel): boolean {
  if (level === 'none') return false;
  if (level === 'paranoid') return category !== 'read';
  // normal: medium-risk + high-risk 需要确认
  return category === 'medium-risk' || category === 'high-risk';
}

function summarizeTool(tool: string, args: Record<string, unknown>): string {
  const def = TOOLS_BY_NAME.get(tool);
  if (!def) return `${tool}(${JSON.stringify(args)})`;
  const pairs = Object.entries(args)
    .filter(([, v]) => {
      const val = v as any;
      return val !== undefined && val !== '' && !(Array.isArray(val) && val.length === 0);
    })
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return `${def.description}${pairs ? `（${pairs}）` : ''}`;
}

function buildRecognitionPrompt(): string {
  const toolDescriptions = TOOLS.map((t) => {
    const shape = Object.entries(t.argsSchema.shape)
      .map(([k, v]) => {
        const zv = v as z.ZodTypeAny;
        const opt = zv.isOptional() ? '?' : '';
        const type = zv instanceof z.ZodEnum ? `enum(${zv.options.join('|')})` : zv.constructor.name.replace('Zod', '').toLowerCase();
        return `${k}${opt}:${type}`;
      })
      .join(', ');
    return `- ${t.name}: ${t.description} 参数: { ${shape} }`;
  }).join('\n');

  return `你是 overSeer 的"意图识别器"。请把用户的自然语言输入解析为一次工具调用。

可用工具：
${toolDescriptions}

规则：
1. 如果用户只是闲聊、问候、询问"你能做什么"，使用 tool: "chat"，args 为空，reply 是友好回复。
2. 如果用户要求查看状态/预算/健康，使用 tool: "status"。
3. 如果用户提到"队列"、"queue"、"任务"但没有指定 id，使用 tool: "queue.list"。
4. 删除队列项用 "queue.drop"，清空队列用 "queue.clear"。
5. "暂停"、"stop"、"pause" 任务循环用 "taskloop.pause"；"恢复"、"继续"、"resume" 用 "taskloop.resume"。
6. "扫描"、"巡检"、"cycle" 用 "cycle.run"；指定项目扫描用 "cycle.scan"。
7. "生成计划"、"plan" 用 "supervise.plan"，需要 project 参数。
8. "开发"、"develop"、"执行" 用 "supervise.develop"；如果用户明确说"写代码"、"execute"，则 execute=true。
9. "审批"、"approve" 用 "approvals.approve"；"拒绝"、"reject" 用 "approvals.reject"。
10. "搜索知识库"、"查找" 用 "kb.search"。
11. "最近笔记" 用 "kb.recent"。
12. "列出项目" 用 "project.list"；"查看项目" 用 "project.show"。
13. "改配置"、"设置" 用 "config.update"，只接受 daemon.autonomy 下的字段。
14. 不确定用户意图时，使用 tool: "chat"，在 reply 中礼貌询问。

输出严格 JSON，不要 markdown 代码块：
{
  "tool": "toolName",
  "args": { ... },
  "summary": "一句话描述你要执行的操作（给用户确认时显示）"
}

如果 tool 是 "chat"，可以额外包含 "reply" 字段作为直接回复。`;
}

function buildSummaryPrompt(userText: string, result: ToolResult): string {
  const data = JSON.stringify(result.data ?? {}, null, 2).slice(0, 4000);
  return `你是 overSeer。用户刚才说："${userText}"\n\n系统执行了工具 ${result.tool}，结果是：\n\n\`\`\`json\n${data}\n\`\`\`\n${result.error ? `\n错误：${result.error}` : ''}\n\n请用简洁、直接的中文总结执行结果。如果出错，说明原因和建议。`;
}

export class ChatToolRouter {
  private log = getLogger('chat-tools');
  constructor(
    private readonly router: Router,
    private readonly opts: ChatToolsOptions = {}
  ) {}

  /**
   * 识别用户意图。正常模式调用 LLM；降级模式使用规则匹配。
   * LLM 调用失败时（如主控不可用），自动降级到规则匹配，避免 chat 完全卡死。
   */
  async recognize(text: string, mode: SupervisionMode): Promise<ToolCallRequest> {
    if (mode === 'degraded' || mode === 'stopped') {
      return this.ruleBasedRecognize(text, mode);
    }
    try {
      return await this.llmRecognize(text);
    } catch (e) {
      this.log.warn({ err: String(e) }, 'llm recognize failed, fallback to rule-based');
      return this.ruleBasedRecognize(text, 'degraded');
    }
  }

  private async llmRecognize(text: string): Promise<ToolCallRequest> {
    const messages: ChatRequest['messages'] = [
      { role: 'system', content: buildRecognitionPrompt() },
      { role: 'user', content: text },
    ];
    const res = await this.router.chat({ messages, task: 'chat-tools', temperature: 0.1, maxTokens: 800 });
    const parsed = extractJsonObject(res.text);
    if (!parsed || typeof parsed.tool !== 'string') {
      this.log.warn({ raw: res.text.slice(0, 200) }, 'tool recognition parse failed, fallback to chat');
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '我没理解你的意思，能再说明一下吗？' };
    }
    return this.normalizeRequest(
      parsed.tool as string,
      (parsed.args as Record<string, unknown>) ?? {},
      (parsed.summary as string) ?? '',
      (parsed.reply as string) ?? undefined
    );
  }

  private ruleBasedRecognize(text: string, mode: SupervisionMode): ToolCallRequest {
    const t = text.trim().toLowerCase();
    const confirmLevel = this.opts.confirmLevel ?? 'normal';
    const needsConfirmFor = (tool: string): boolean => {
      const cat = TOOLS_BY_NAME.get(tool)?.category ?? 'read';
      return needsConfirm(cat, confirmLevel);
    };

    if (mode === 'stopped') {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '当前为 stopped 模式，只能查看状态。请配置主控 provider 或启用 fallback 后再执行操作。' };
    }

    // 状态
    if (/状态|status|健康|预算|budget|provider|模式|mode/.test(t)) {
      return { tool: 'status', args: {}, needsConfirm: needsConfirmFor('status'), summary: '查看当前状态' };
    }
    // 暂停
    if (/暂停|pause|停止.*循环|stop.*task|stop.*loop/.test(t)) {
      return { tool: 'taskloop.pause', args: {}, needsConfirm: needsConfirmFor('taskloop.pause'), summary: '暂停任务循环' };
    }
    // 恢复
    if (/恢复|继续|resume|start.*loop|开始.*循环/.test(t)) {
      return { tool: 'taskloop.resume', args: {}, needsConfirm: needsConfirmFor('taskloop.resume'), summary: '恢复任务循环' };
    }
    // 项目
    if (/项目|project/.test(t)) {
      return { tool: 'project.list', args: {}, needsConfirm: needsConfirmFor('project.list'), summary: '列出项目' };
    }
    // 审批
    if (/审批|approval|approve|reject|拒绝/.test(t)) {
      return { tool: 'approvals.list', args: {}, needsConfirm: needsConfirmFor('approvals.list'), summary: '列出审批项' };
    }
    // 队列：先检查清空/删除，再泛匹配
    if (/清空|clear/.test(t)) {
      return { tool: 'queue.clear', args: {}, needsConfirm: needsConfirmFor('queue.clear'), summary: '清空队列' };
    }
    if (/删除|drop/.test(t)) {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '降级模式下请提供队列项 id，例如 "删除 q-xxx"。' };
    }
    if (/队列|queue|任务|task/.test(t)) {
      return { tool: 'queue.list', args: {}, needsConfirm: needsConfirmFor('queue.list'), summary: '列出队列' };
    }
    // 扫描/巡检
    if (/扫描|scan|巡检|cycle/.test(t)) {
      return { tool: 'cycle.run', args: {}, needsConfirm: needsConfirmFor('cycle.run'), summary: '运行一轮巡检' };
    }
    // 计划
    const planMatch = t.match(/plan|计划/);
    if (planMatch) {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '降级模式下无法准确识别项目名，请在 normal 模式下使用 "给 <项目> 生成 plan"。' };
    }
    // 知识库
    if (/知识库|vault|搜索|search/.test(t)) {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '降级模式下请用 "overseer kb search <关键词>" 搜索知识库。' };
    }

    return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: '降级模式下我只能处理简单的状态/队列/任务循环/巡检指令。请切回 normal 模式或使用 CLI。' };
  }

  private normalizeRequest(
    tool: string,
    args: Record<string, unknown>,
    summary: string,
    reply?: string
  ): ToolCallRequest {
    const def = TOOLS_BY_NAME.get(tool);
    if (!def) {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: `未知工具 ${tool}，我把它当作普通聊天处理。` };
    }
    if (tool === 'chat') {
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: (reply || summary || '有什么可以帮你的？') };
    }

    // schema 校验并填充默认值
    const parsed = def.argsSchema.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return { tool: 'chat', args: {}, needsConfirm: false, summary: '', reply: `参数不对：${issues}。请补充信息后再试。` };
    }

    const confirmLevel = this.opts.confirmLevel ?? 'normal';
    const needsConfirmFlag = needsConfirm(def.category, confirmLevel);
    return {
      tool,
      args: parsed.data,
      needsConfirm: needsConfirmFlag,
      summary: summary || summarizeTool(tool, parsed.data),
    };
  }

  /**
   * 执行工具调用。
   */
  async execute(ctx: ChatToolContext, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const def = TOOLS_BY_NAME.get(tool);
    if (!def) return result(tool, undefined, `未知工具：${tool}`);
    if (this.opts.allowActions === false && def.category !== 'read') {
      return result(tool, undefined, '当前配置禁止 chat 执行写操作，请修改 daemon.chat.allowActions 或使用 CLI。');
    }
    try {
      return await def.execute(ctx, args);
    } catch (e) {
      this.log.warn({ err: String(e), tool }, 'tool execution failed');
      return result(tool, undefined, (e as Error).message);
    }
  }

  /**
   * 把工具执行结果转换为自然语言回复。
   */
  async summarize(userText: string, result: ToolResult): Promise<string> {
    if (result.tool === 'chat') return result.error ?? '有什么可以帮你的？';
    try {
      const messages: ChatRequest['messages'] = [
        { role: 'system', content: buildSummaryPrompt(userText, result) },
      ];
      const res = await this.router.chat({ messages, task: 'summary', temperature: 0.3, maxTokens: 800 });
      return res.text;
    } catch (e) {
      this.log.warn({ err: String(e) }, 'summarize failed, fallback to raw result');
      return result.error
        ? `执行失败：${result.error}`
        : `执行完成（${result.tool}）。结果：\n\n\`\`\`json\n${JSON.stringify(result.data ?? {}, null, 2).slice(0, 1000)}\n\`\`\``;
    }
  }

  listTools(): { name: string; description: string; category: ToolCategory }[] {
    return TOOLS.map((t) => ({ name: t.name, description: t.description, category: t.category }));
  }
}
