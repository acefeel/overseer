import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useApp, useStdin, useInput } from 'ink';
import { StatusBar } from './components/StatusBar.js';
import { QueueList, type QueueItem as TuiQueueItem } from './components/QueueList.js';
import { ActivityLog, type ActivityEntry } from './components/ActivityLog.js';
import { HelpBar } from './components/HelpBar.js';
import { TaskLoopPanel, type TaskLoopData } from './components/TaskLoopPanel.js';
import { ActionMenu } from './components/ActionMenu.js';
import { ChatPanel } from './components/ChatPanel.js';
import { QueuePanel } from './components/QueuePanel.js';
import { ApprovalsPanel } from './components/ApprovalsPanel.js';
import { VaultPanel } from './components/VaultPanel.js';
import { PlanPanel } from './components/PlanPanel.js';
import { CyclePanel } from './components/CyclePanel.js';
import { loadConfig } from '../util/config.js';
import { IpcClient } from '../daemon/ipc.js';
import { launchDaemon } from '../daemon/launcher.js';

type Page =
  | 'dashboard'
  | 'menu'
  | 'chat'
  | 'queue'
  | 'approvals'
  | 'vault'
  | 'plan'
  | 'cycle';

interface StatusData {
  mode: string;
  fallback: string | null;
  worker: string | null;
  consultant: string | null;
  providers: Array<{
    id: string;
    kind: string;
    role: string;
    ready: boolean;
    model: string;
    canAct: boolean;
  }>;
  activeChain: string[];
  budget: {
    level: string;
    daily: { used: number; limit: number; remaining: number; pct: number };
    weekly: { used: number; limit: number; remaining: number; pct: number };
    safetyPad: number;
    recommendation: string;
    asOf: string;
  };
  historyLen: number;
  vaultNotes: number;
  taskLoop: TaskLoopData | null;
}

interface AppState {
  daemonAlive: boolean;
  daemonStarting: boolean;
  status: StatusData | null;
  queue: TuiQueueItem[];
  activity: ActivityEntry[];
  lastAction?: string;
  error?: string;
}

const MENU_ITEMS = [
  { key: 'cycle', label: 'Run Cycle', desc: '跑一轮自主巡检' },
  { key: 'queue', label: 'Queue', desc: '查看/执行队列' },
  { key: 'plan', label: 'Plan', desc: '对项目生成意向' },
  { key: 'approvals', label: 'Approvals', desc: '审批待执行动作' },
  { key: 'chat', label: 'Chat', desc: '与 overSeer 对话' },
  { key: 'vault', label: 'Vault', desc: '搜索/最近笔记' },
];

/** 全局热键处理器，只在 dashboard 挂载；进入子页面后由各页面自己接管 */
function GlobalHotkeys({
  onMenu,
  onChat,
  onQueue,
  onApprovals,
  onVault,
  onPlan,
  onCycle,
  onRun,
  onQuit,
  onQuitAll,
  onRestartDaemon,
  onPauseLoop,
  onResumeLoop,
}: {
  onMenu: () => void;
  onChat: () => void;
  onQueue: () => void;
  onApprovals: () => void;
  onVault: () => void;
  onPlan: () => void;
  onCycle: () => void;
  onRun: () => void;
  onQuit: () => void;
  onQuitAll: () => Promise<void>;
  onRestartDaemon: () => Promise<void>;
  onPauseLoop: () => Promise<void>;
  onResumeLoop: () => Promise<void>;
}) {
  useInput((input, key) => {
    const k = input.toLowerCase();
    if (input === 'Q') {
      onQuitAll();
    } else if (k === 'q') {
      onQuit();
    } else if (k === 'm') {
      onMenu();
    } else if (k === 'c') {
      onChat();
    } else if (k === 'w') {
      onQueue();
    } else if (k === 'a') {
      onApprovals();
    } else if (k === 'v') {
      onVault();
    } else if (k === 'p') {
      onPlan();
    } else if (k === 'y') {
      onCycle();
    } else if (k === 'r') {
      onRun();
    } else if (k === 'd') {
      onRestartDaemon();
    } else if (k === 'x') {
      onPauseLoop();
    } else if (key.return || input === ' ') {
      onResumeLoop();
    }
  });
  return null;
}

export function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const [state, setState] = useState<AppState>({
    daemonAlive: false,
    daemonStarting: false,
    status: null,
    queue: [],
    activity: [],
  });
  const [page, setPage] = useState<Page>('dashboard');
  const [menuIndex, setMenuIndex] = useState(0);

  const ipcName = loadConfig().daemon.ipcName;
  const ipc = new IpcClient(ipcName);

  const notify = useCallback((msg: string) => {
    setState((s) => ({ ...s, lastAction: msg }));
  }, []);

  const refresh = useCallback(async () => {
    const alive = await ipc.isAlive().catch(() => false);
    if (!alive) {
      setState((s) => ({
        ...s,
        daemonAlive: false,
        status: null,
        queue: [],
        lastAction: s.daemonStarting ? s.lastAction : 'daemon not reachable',
      }));
      return;
    }
    try {
      const status = (await ipc.request('status')) as StatusData;
      const recent = (await ipc
        .request('kb.recent', { limit: 8 })
        .catch(() => [])) as any[];
      const activity: ActivityEntry[] = [];
      for (const note of recent) {
        const fm = note.frontmatter || {};
        if (fm.type === 'budget' && Array.isArray(fm.tags) && fm.tags.includes('mode')) {
          activity.push({
            kind: 'mode',
            ts: fm.createdAt ?? new Date().toISOString(),
            text: `mode note: ${note.slug}`,
          });
        } else if (['plan', 'design', 'retro'].includes(fm.type)) {
          activity.push({
            kind: 'memory',
            ts: fm.createdAt ?? new Date().toISOString(),
            text: `${fm.type}: ${note.slug}`,
          });
        }
      }
      setState((s) => ({
        ...s,
        daemonAlive: true,
        daemonStarting: false,
        status,
        activity,
        lastAction: s.lastAction,
        error: undefined,
      }));
    } catch (e) {
      setState((s) => ({
        ...s,
        daemonStarting: false,
        lastAction: `error: ${(e as Error).message}`,
      }));
    }
  }, [ipc]);

  const autoStartOnce = useCallback(async () => {
    const alive = await ipc.isAlive().catch(() => false);
    if (alive) return;
    setState((s) => ({ ...s, daemonStarting: true, lastAction: '自动启动 daemon…' }));
    const r = await launchDaemon(ipcName, { timeoutMs: 10000 });
    if (r.ok) {
      setState((s) => ({ ...s, lastAction: `daemon 已起 (pid ${r.pid})` }));
      await refresh();
    } else {
      setState((s) => ({
        ...s,
        daemonStarting: false,
        lastAction: `daemon 启动失败：${r.error}`,
      }));
    }
  }, [ipc, ipcName, refresh]);

  useEffect(() => {
    (async () => {
      await refresh();
      if (!state.daemonAlive && !state.daemonStarting) {
        await autoStartOnce();
      }
    })();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doRun = useCallback(() => {
    if (!state.daemonAlive) {
      setState((s) => ({ ...s, lastAction: 'daemon not running' }));
      return;
    }
    setState((s) => ({ ...s, lastAction: 'ping daemon…' }));
    ipc
      .request('ping')
      .then(() => setState((s) => ({ ...s, lastAction: 'ping ✓' })))
      .catch((e) => setState((s) => ({ ...s, lastAction: `error: ${(e as Error).message}` })));
  }, [state.daemonAlive, ipc]);

  const doQuitAll = useCallback(async () => {
    setState((s) => ({ ...s, lastAction: 'shutting down daemon + TUI…' }));
    try {
      if (state.daemonAlive) {
        await ipc.request('shutdown');
      }
    } catch {
      /* daemon 可能已先退 */
    }
    exit();
  }, [state.daemonAlive, ipc, exit]);

  const doRestartDaemon = useCallback(async () => {
    setState((s) => ({ ...s, daemonStarting: true, lastAction: '重启 daemon…' }));
    if (state.daemonAlive) {
      try {
        await ipc.request('shutdown');
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = await launchDaemon(ipcName, { timeoutMs: 10000 });
    if (r.ok) {
      setState((s) => ({ ...s, daemonStarting: false, lastAction: `daemon 重启完成 (pid ${r.pid})` }));
      await refresh();
    } else {
      setState((s) => ({
        ...s,
        daemonStarting: false,
        lastAction: `重启失败：${r.error}`,
      }));
    }
  }, [state.daemonAlive, ipc, ipcName, refresh]);

  const doPauseLoop = useCallback(async () => {
    setState((s) => ({ ...s, lastAction: 'pausing task loop…' }));
    try {
      const r = await ipc.request('taskloop.pause');
      setState((s) => ({ ...s, lastAction: `loop paused (${(r as any).state})` }));
    } catch (e) {
      setState((s) => ({ ...s, lastAction: `pause 失败: ${(e as Error).message}` }));
    }
  }, [ipc]);

  const doResumeLoop = useCallback(async () => {
    setState((s) => ({ ...s, lastAction: 'resuming task loop…' }));
    try {
      const r = await ipc.request('taskloop.resume');
      setState((s) => ({ ...s, lastAction: `loop resumed (${(r as any).state})` }));
    } catch (e) {
      setState((s) => ({ ...s, lastAction: `resume 失败: ${(e as Error).message}` }));
    }
  }, [ipc]);

  const renderPage = () => {
    switch (page) {
      case 'menu':
        return (
          <ActionMenu
            items={MENU_ITEMS}
            selected={menuIndex}
            onSelect={(idx) => {
              if (typeof idx === 'number') {
                setMenuIndex(idx);
                setPage(MENU_ITEMS[idx].key as Page);
              }
            }}
            onClose={() => setPage('dashboard')}
          />
        );
      case 'chat':
        return <ChatPanel ipc={ipc} onClose={() => setPage('dashboard')} mode={state.status?.mode} />;
      case 'queue':
        return <QueuePanel ipc={ipc} onClose={() => setPage('dashboard')} onNotify={notify} />;
      case 'approvals':
        return <ApprovalsPanel ipc={ipc} onClose={() => setPage('dashboard')} onNotify={notify} />;
      case 'vault':
        return <VaultPanel ipc={ipc} onClose={() => setPage('dashboard')} onNotify={notify} />;
      case 'plan':
        return <PlanPanel ipc={ipc} onClose={() => setPage('dashboard')} onNotify={notify} />;
      case 'cycle':
        return <CyclePanel ipc={ipc} onClose={() => setPage('dashboard')} onNotify={notify} />;
      default:
        return null;
    }
  };

  const dashboardVisible = page === 'dashboard';

  return (
    <Box flexDirection="column" padding={1}>
      <StatusBar status={state.status} />

      {dashboardVisible && state.status?.taskLoop && (
        <Box marginTop={1}>
          <TaskLoopPanel data={state.status.taskLoop} />
        </Box>
      )}

      {!dashboardVisible ? (
        <Box marginTop={1}>{renderPage()}</Box>
      ) : (
        <Box marginTop={1}>
          <Box flexDirection="column" width="60%">
            <QueueList items={state.queue} />
          </Box>
          <Box flexDirection="column" width="40%">
            <ActivityLog entries={state.activity} />
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <HelpBar daemonAlive={state.daemonAlive} lastAction={state.lastAction} />
      </Box>

      {state.daemonStarting && (
        <Box marginTop={1}>
          <Text color="cyan">🔄 正在启动 daemon…</Text>
        </Box>
      )}

      {!state.daemonAlive && !state.daemonStarting && (
        <Box marginTop={1}>
          <Text color="yellow">⚠ daemon 未运行。</Text>
          <Text color="gray">按 </Text>
          <Text color="cyan" bold>d </Text>
          <Text color="gray">手动重启，或 </Text>
          <Text color="cyan" bold>Q </Text>
          <Text color="gray">退出</Text>
        </Box>
      )}

      {isRawModeSupported && dashboardVisible && (
        <GlobalHotkeys
          onMenu={() => setPage('menu')}
          onChat={() => setPage('chat')}
          onQueue={() => setPage('queue')}
          onApprovals={() => setPage('approvals')}
          onVault={() => setPage('vault')}
          onPlan={() => setPage('plan')}
          onCycle={() => setPage('cycle')}
          onRun={doRun}
          onQuit={() => exit()}
          onQuitAll={doQuitAll}
          onRestartDaemon={doRestartDaemon}
          onPauseLoop={doPauseLoop}
          onResumeLoop={doResumeLoop}
        />
      )}

      {!isRawModeSupported && (
        <Box marginTop={1}>
          <Text color="gray">
            ⚠ 当前 stdin 不支持 raw mode（可能被重定向）。热键禁用；只读 dashboard。
          </Text>
        </Box>
      )}
    </Box>
  );
}
