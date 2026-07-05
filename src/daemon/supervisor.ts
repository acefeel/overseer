import fs from 'node:fs';
import { getTracker } from '../budget/tracker.js';
import { BudgetPolicy } from '../budget/policy.js';
import { loadConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { PATHS } from '../util/paths.js';
import type { ChatRequest } from '../providers/base.js';
import { Router } from '../providers/router.js';
import type { IpcHandler, IpcRequest } from './ipc.js';
import { Vault } from '../kb/vault.js';
import { VaultWriter } from '../kb/writer.js';
import { VaultRetriever } from '../kb/retriever.js';
import { VaultSearcher } from '../kb/searcher.js';
import { MemoryJudge, type JudgeDecision } from '../kb/judge.js';
import type { NoteType } from '../kb/schema.js';
import {
  DEGRADED_BANNER,
  degradedReasonLine,
  ModePolicy,
  type ActionType,
  type ModeDecision,
  type SupervisionMode,
} from './mode.js';
import type { TaskLoop } from './taskloop.js';
import { Autonomy, type Aggressiveness } from '../supervisor/autonomy.js';
import * as queue from '../supervisor/queue.js';
import * as approvals from '../supervisor/approvals.js';
import { PdcaeLoop } from '../supervisor/loop.js';
import { HealthProbe } from '../providers/health.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** 跳过 KB 检索（不读 vault） */
  noRetrieve?: boolean;
  /** 跳过记忆判断与写入（不调 judge、不写 vault） */
  noJudge?: boolean;
}

export interface ChatResult {
  reply: string;
  model: string;
  provider: string;
  retrievedNotes: number;
  memoryWritten?: { type: string; rel: string } | null;
  mode: SupervisionMode;
  degraded?: boolean;
}

const SYSTEM_BASE_NORMAL =
  '你是 overSeer，一个有预算意识、自我观测、维护 Obsidian 知识库的开发监理 agent。' +
  '简明、直接、中英混排回答。当被问及"健康/进度/预算"，用结构化短句回答。' +
  '若提供的【已有记忆】里有相关条目，请引用其结论（如"见 [[xxx]]"）并与其保持一致。';

const SYSTEM_BASE_DEGRADED =
  '你是 overSeer 的降级实例（运行在本地小模型上）。' +
  '当前主力模型预算接近上限，你只用于：调度、事件响应、对用户输入做简要回复。' +
  '**你不能修改任何文件、不能执行命令、不能写记忆。**' +
  '回答要简明、坦诚；若用户要做有副作用的操作，告知预算恢复后再来。' +
  '当被问及健康/预算，根据【已有记忆】和【状态快照】如实回答。';

import { VaultRecorder } from '../kb/recorder.js';

export class Supervisor {
  readonly router: Router;
  readonly budget: BudgetPolicy;
  readonly vault: Vault;
  readonly writer: VaultWriter;
  readonly retriever: VaultRetriever;
  readonly judge: MemoryJudge;
  readonly modePolicy: ModePolicy;
  readonly recorder: VaultRecorder;
  readonly searcher: VaultSearcher;
  private log = getLogger('supervisor');
  private history: ChatTurn[] = [];
  private currentMode: SupervisionMode = 'normal';
  private taskLoop?: TaskLoop;

  constructor() {
    const cfg = loadConfig();
    this.vault = new Vault();
    this.vault.ensure();
    this.writer = new VaultWriter(this.vault);
    this.recorder = new VaultRecorder(this.writer);
    this.router = new Router(cfg);
    this.router.setRecorder(this.recorder);
    this.budget = new BudgetPolicy(cfg.budget, getTracker());
    this.retriever = new VaultRetriever(this.vault);
    this.searcher = new VaultSearcher(this.retriever);
    this.judge = new MemoryJudge(this.router);
    this.modePolicy = new ModePolicy();
    this.recomputeMode();
  }

  /** 根据当前预算 + 主链可用性 + fallback 可用性，重新决定模式。返回是否发生切换。 */
  recomputeMode(): { decision: ModeDecision; changed: boolean } {
    const snap = this.budget.snapshot();
    const mainReady = this.router.mainChainReady();
    const hasFallback = this.router.hasFallback();
    const decision = this.modePolicy.decide(snap, mainReady, hasFallback);
    const changed = decision.mode !== this.currentMode;
    if (changed) {
      const prev = this.currentMode;
      this.modePolicy.onTransition(prev, decision.mode, decision);
      this.currentMode = decision.mode;
      this.recordModeTransition(prev, decision).catch((e) =>
        this.log.warn({ err: String(e) }, 'recordModeTransition failed')
      );
    }
    return { decision, changed };
  }

  get mode(): SupervisionMode {
    return this.currentMode;
  }

  private async recordModeTransition(prev: SupervisionMode, decision: ModeDecision): Promise<void> {
    if (!this.vault) return;
    try {
      const result = this.writer.write({
        type: 'budget',
        project: 'overSeer',
        title: `mode ${prev}→${decision.mode} (${decision.trigger})`,
        tags: ['mode', 'budget', decision.mode, prev, decision.trigger],
        body: [
          `## 切换`,
          `- 时刻：${new Date().toISOString()}`,
          `- from → to：${prev} → ${decision.mode}`,
          `- 触发：${decision.trigger}`,
          `- 预算等级：${decision.fromLevel}`,
          `- 原因：${decision.reason}`,
          '',
          '## 语义',
          decision.mode === 'degraded'
            ? '主控不可用或预算逼近上限；改由本地 fallback 接管 chat/调度；后续副作用动作仍受 manifest + approvals 约束。'
            : decision.mode === 'stopped'
            ? '主控不可用且无可用的 fallback，daemon 暂停所有 LLM 调用。'
            : '主控恢复可用且预算正常，切回主控，恢复完整能力。',
        ].join('\n'),
      });
      this.writer.appendDaily(
        `mode ${prev}→${decision.mode}`,
        `触发=${decision.trigger} · 预算=${decision.fromLevel}\n\n[[${result.note.relativePath.replace(/\.md$/, '')}]]`
      );
    } catch {
      /* non-critical */
    }
  }

  async chat(text: string, opts: ChatOptions = {}): Promise<ChatResult> {
    // 用户主动 chat → 唤醒 task loop（如果它在 resting）
    this.taskLoop?.resume();

    const { decision } = this.recomputeMode();
    const mode = decision.mode;

    if (mode === 'stopped') {
      const snap = this.budget.snapshot();
      const mainReady = this.router.mainChainReady();
      const why = !mainReady
        ? '主控 provider 不可用（未配置 apiKey 或 disabled）'
        : `预算 ${snap.level}（剩余 ${Math.min(
            snap.daily.remaining,
            snap.weekly.remaining
          )} tokens ≤ 安全垫 ${snap.safetyPad}）`;
      const msg =
        `🛑 ${why}，且没有可用的本地 fallback。` +
        `daemon 进入 stop 状态。修复路径：填主控 key、上调预算，或启用 providers.local。`;
      this.log.warn({ level: snap.level, mainReady, trigger: decision.trigger }, 'chat rejected (stopped)');
      return {
        reply: msg,
        model: '-',
        provider: '-',
        retrievedNotes: 0,
        memoryWritten: null,
        mode,
      };
    }

    const degraded = mode === 'degraded';
    const mainReady = this.router.mainChainReady();

    let retrieved = 0;
    let contextBlock = '';
    if (!opts.noRetrieve) {
      try {
        const hits = this.searcher.search({ q: text, limit: 5 }, { linkBoost: 3, relatedDepth: 1 });
        retrieved = hits.length;
        if (retrieved > 0) {
          contextBlock =
            '\n\n## 已有记忆（请保持一致）\n\n' +
            this.retriever.renderContext(hits, { maxChars: 1800 });
        }
      } catch (e) {
        this.log.debug({ err: String(e) }, 'retrieve failed, continuing');
      }
    }

    this.history.push({ role: 'user', content: text });

    const systemBase = degraded ? SYSTEM_BASE_DEGRADED : SYSTEM_BASE_NORMAL;
    const statusSnap = degraded
      ? `\n\n## 当前状态快照\n\n\`\`\`json\n${JSON.stringify(this.budget.snapshot(), null, 2)}\n\`\`\`\n\n主控 ready: ${mainReady}`
      : '';
    const messages: ChatRequest['messages'] = [
      { role: 'system', content: systemBase + contextBlock + statusSnap },
      ...this.history.slice(-20),
    ];
    const req: ChatRequest = { messages, task: 'chat', temperature: 0.7 };

    const providerForEstimate =
      this.router.getProvider(this.router.activeChain[0] ?? '') ??
      this.router.getFallbackProvider();
    const estimated =
      (await providerForEstimate?.countTokens(messages).catch(() => 0)) ?? 0;

    if (!degraded) {
      const canRun = this.budget.canRunTask(estimated || 2000);
      if (!canRun.ok) {
        this.log.warn({ reason: canRun.reason }, 'chat blocked by budget policy');
      }
    }

    let res: { text: string; model: string; usage: any; providerId: string };
    try {
      if (degraded) {
        res = await this.router.chatViaFallback(req);
      } else {
        res = await this.router.chat(req);
      }
    } catch (e) {
      getTracker().record('?', '?', { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, {
        task: 'chat',
        ok: false,
        error: (e as Error).message,
      });
      throw e;
    }
    getTracker().record(res.providerId, res.model, res.usage, { task: 'chat' });
    this.history.push({ role: 'assistant', content: res.text });
    if (this.history.length > 40) {
      this.history = this.history.slice(-40);
    }

    let memoryWritten: ChatResult['memoryWritten'] = null;
    if (!degraded && !opts.noJudge && res.providerId !== '-') {
      const judgeGate = this.modePolicy.canPerform('memory.write' as ActionType, this.currentMode);
      if (judgeGate.ok) {
        memoryWritten = await this.maybeWriteMemory(text, res.text, contextBlock).catch((e) => {
          this.log.warn({ err: String(e) }, 'maybeWriteMemory failed');
          return null;
        });
      }
    }

    const reply = degraded
      ? DEGRADED_BANNER + degradedReasonLine(decision.trigger as any) + res.text
      : res.text;

    const chatResult: ChatResult = {
      reply,
      model: res.model,
      provider: res.providerId,
      retrievedNotes: retrieved,
      memoryWritten,
      mode,
      degraded,
    };

    // 写入 chat_log 作为审计，不依赖 judge 且不阻塞返回
    this.recordChatLog(
      [
        ...messages.slice(-2).map((m) => ({ role: m.role, content: m.content } as ChatTurn)),
        { role: 'assistant', content: res.text },
      ],
      chatResult
    ).catch((e: Error) => this.log.warn({ err: String(e) }, 'recordChatLog failed'));

    return chatResult;
  }

  private async recordChatLog(turns: ChatTurn[], result: ChatResult): Promise<void> {
    if (turns.length === 0) return;
    try {
      const lines = turns.map((t) => `## ${t.role}\n\n${t.content}`);
      this.writer.write({
        type: 'chat_log',
        project: 'overSeer',
        title: `chat ${new Date().toISOString()} - ${result.provider}/${result.model}`,
        tags: ['chat_log', result.mode, result.provider],
        body: [
          ...lines,
          '',
          `## meta`,
          `- provider: ${result.provider}`,
          `- model: ${result.model}`,
          `- mode: ${result.mode}`,
          `- retrievedNotes: ${result.retrievedNotes}`,
          `- memoryWritten: ${result.memoryWritten ? `${result.memoryWritten.type}→[[${result.memoryWritten.rel}]]` : '(none)'}`,
        ].join('\n'),
      });
    } catch (e) {
      this.log.warn({ err: String(e) }, 'recordChatLog failed');
    }
  }

  private async maybeWriteMemory(
    userText: string,
    assistantText: string,
    contextBlock: string
  ): Promise<{ type: string; rel: string } | null> {
    const decision: JudgeDecision = await this.judge.evaluate({
      userText,
      assistantText,
      recentContext: contextBlock || undefined,
    });
    if (!decision.shouldWrite || !decision.note) {
      this.log.debug({ reason: decision.reason }, 'judge: no memory written');
      return null;
    }
    try {
      const n = decision.note;
      const result = this.writer.write({
        type: n.type as NoteType,
        project: n.project,
        title: n.title,
        tags: n.tags,
        body: n.body,
        status: 'active',
      });
      if (n.dailyMention !== false) {
        this.writer.appendDaily(
          `记忆 - ${n.title}`,
          `type=${n.type} · project=${n.project}\n\n[[${result.note.relativePath.replace(/\.md$/, '')}]]\n\n${n.body.split('\n').slice(0, 3).join('\n')}`
        );
      }
      const rel = result.note.relativePath.replace(/\.md$/, '');
      this.log.info({ type: n.type, rel }, 'memory written');
      return { type: n.type, rel };
    } catch (e) {
      this.log.warn({ err: String(e) }, 'memory write failed');
      return null;
    }
  }

  status(): unknown {
    const snap = this.budget.snapshot();
    let noteCount = 0;
    try {
      noteCount = this.retriever.all().length;
    } catch {
      /* ignore */
    }
    return {
      providers: this.router.listProviders(),
      activeChain: this.router.activeChain,
      fallback: this.router.fallbackProviderId ?? null,
      worker: this.router.getWorkerProvider()?.id ?? null,
      consultant: this.router.getConsultantProvider()?.id ?? null,
      mode: this.currentMode,
      budget: snap,
      historyLen: this.history.length,
      vaultNotes: noteCount,
      taskLoop: this.taskLoop?.snapshot() ?? null,
    };
  }

  setTaskLoop(tl: TaskLoop): void {
    this.taskLoop = tl;
  }

  private pdcae?: PdcaeLoop;

  private getPdcae(): PdcaeLoop {
    if (!this.pdcae) {
      this.pdcae = new PdcaeLoop(
        this.router,
        this.modePolicy,
        () => this.currentMode,
        this.writer,
        (est: number) => this.budget.canRunTask(est)
      );
    }
    return this.pdcae;
  }

  private getAutonomy(): Autonomy {
    return new Autonomy({
      router: this.router,
      modePolicy: this.modePolicy,
      budget: this.budget,
      writer: this.writer,
      currentMode: () => this.currentMode,
      recomputeMode: () => this.recomputeMode(),
    });
  }

  reset(): void {
    this.history = [];
  }

  ipcHandler(): IpcHandler {
    return async (req: IpcRequest) => {
      switch (req.op) {
        case 'ping':
          return { pong: true, ts: new Date().toISOString() };
        case 'status':
          this.recomputeMode();
          return this.status();
        case 'chat': {
          const p = (req.payload as { text?: string; opts?: ChatOptions }) ?? {};
          if (!p.text) throw new Error("missing 'text' in chat payload");
          return this.chat(p.text, p.opts);
        }
        case 'kb.search': {
          const q = (req.payload as Record<string, unknown>) ?? {};
          return this.searcher.search(
            {
              q: q.q as string | undefined,
              type: q.type as NoteType | undefined,
              project: q.project as string | undefined,
              tag: q.tag as string | undefined,
              status: q.status as string | undefined,
              since: q.since as string | undefined,
              limit: q.limit as number | undefined,
            },
            { linkBoost: (q.linkBoost as number) ?? 2, relatedDepth: (q.relatedDepth as number) ?? 0 }
          );
        }
        case 'kb.related': {
          const p = (req.payload as { rel?: string; limit?: number }) ?? {};
          if (!p.rel) throw new Error("missing 'rel' in kb.related payload");
          return this.searcher.related(p.rel, p.limit ?? 5);
        }
        case 'kb.recent': {
          const p = (req.payload as { limit?: number; type?: NoteType }) ?? {};
          return this.retriever.recent(p.limit ?? 10, p.type);
        }
        case 'reset':
          this.reset();
          return { ok: true };
        case 'taskloop.state':
          return this.taskLoop?.snapshot() ?? { state: 'idle' };
        case 'taskloop.pause':
          await this.taskLoop?.stop();
          return { ok: true, state: this.taskLoop?.snapshot().state };
        case 'taskloop.resume':
          this.taskLoop?.resume();
          return { ok: true, state: this.taskLoop?.snapshot().state };
        case 'cycle.run': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          const out = await this.getAutonomy().runCycle({
            aggressiveness: (p.aggressiveness as Aggressiveness) ?? 'normal',
            autoExecute: p.autoExecute === true,
            allowShellDuringScan: p.allowShellDuringScan === true,
            onlyProjects: Array.isArray(p.onlyProjects) ? (p.onlyProjects as string[]) : [],
          });
          return out;
        }
        case 'queue.list': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          return queue.list({
            project: p.project as string | undefined,
            status: p.status as queue.QueueItemStatus | undefined,
            limit: (p.limit as number) ?? 50,
          });
        }
        case 'queue.show': {
          const id = (req.payload as Record<string, unknown>)?.id as string | undefined;
          if (!id) throw new Error("missing 'id' in queue.show payload");
          return queue.getById(id);
        }
        case 'queue.drop': {
          const id = (req.payload as Record<string, unknown>)?.id as string | undefined;
          if (!id) throw new Error("missing 'id' in queue.drop payload");
          return { dropped: queue.drop(id) };
        }
        case 'queue.execute': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          const id = p.id as string | undefined;
          if (!id) throw new Error("missing 'id' in queue.execute payload");
          const item = queue.getById(id);
          if (!item) throw new Error(`queue item not found: ${id}`);
          const result = await this.getPdcae().executeQueueItem(item);
          return result;
        }
        case 'approvals.list': {
          const pendingOnly = (req.payload as Record<string, unknown>)?.pendingOnly ?? true;
          return pendingOnly === false ? approvals.listAll() : approvals.listPending();
        }
        case 'approvals.decide': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          const id = p.id as string | undefined;
          const status = p.status as 'approved' | 'rejected' | undefined;
          if (!id || !status) throw new Error("missing 'id' or 'status' in approvals.decide payload");
          const result = approvals.decide(id, status, 'tui');
          if (!result) throw new Error(`approval not found: ${id}`);
          return result;
        }
        case 'supervise.plan': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          const project = p.project as string | undefined;
          if (!project) throw new Error("missing 'project' in supervise.plan payload");
          return this.getPdcae().plan(project, p.hint as string | undefined);
        }
        case 'supervise.develop': {
          const p = (req.payload as Record<string, unknown>) ?? {};
          const id = p.id as string | undefined;
          const execute = p.execute === true;
          if (!id) throw new Error("missing 'id' in supervise.develop payload");
          if (execute) return this.getPdcae().develop(id, false);
          return this.getPdcae().executeIntention(id);
        }
        case 'health.check': {
          const cfg = loadConfig();
          const probe = new HealthProbe(cfg, 0);
          const ids = Object.keys(cfg.providers);
          const results = [];
          for (const id of ids) results.push(await probe.checkProvider(id, true));
          return { providers: results, fallbackUsable: await probe.fallbackUsable() };
        }
        case 'shutdown': {
          this.log.warn('shutdown requested via IPC, exiting in 200ms');
          // 同步清 PID 文件 + 硬退，避免依赖 ipc.close()（会等当前请求结束 → 死锁）
          setTimeout(() => {
            try {
              if (fs.existsSync(PATHS.PID_FILE)) fs.unlinkSync(PATHS.PID_FILE);
            } catch {
              /* ignore */
            }
            process.exit(0);
          }, 200);
          return { ok: true, message: 'shutting down', pid: process.pid };
        }
        default:
          throw new Error(`unknown op '${req.op}'`);
      }
    };
  }
}
