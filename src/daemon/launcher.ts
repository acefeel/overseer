import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PATHS, ensureDataDirs } from '../util/paths.js';
import { pipePath } from './ipc.js';
import { getLogger } from '../util/logger.js';

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  alreadyRunning?: boolean;
  ipcPipe?: string;
  error?: string;
}

async function isPidAlive(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动 overSeer daemon（如果没在跑）。可被 CLI / TUI 共用。
 *
 * 流程：
 * 1. 检 PID 文件 + 进程存活 → 已在跑，直接返回 alreadyRunning
 * 2. 否则 spawn 一个 detached 子进程跑 dist/daemon/index.js（dev 模式跑 tsx src/...）
 * 3. 轮询等 named pipe 出现（最多 timeoutMs）
 */
export async function launchDaemon(
  ipcName = 'overseer',
  opts: { timeoutMs?: number; logger?: (msg: string) => void } = {}
): Promise<LaunchResult> {
  const log = getLogger('launcher');
  const trace = opts.logger ?? ((m: string) => log.info({ msg: m }, 'launchDaemon'));
  ensureDataDirs();
  const pipe = pipePath(ipcName);

  // 1. 已在跑？
  if (fs.existsSync(PATHS.PID_FILE)) {
    const pidStr = fs.readFileSync(PATHS.PID_FILE, 'utf8').trim();
    const pid = Number(pidStr);
    if (pid && (await isPidAlive(pid))) {
      trace(`already running pid=${pid}`);
      return { ok: true, pid, alreadyRunning: true, ipcPipe: pipe };
    }
    try {
      fs.unlinkSync(PATHS.PID_FILE);
    } catch {
      /* ignore */
    }
  }

  // 2. 选入口（dist 优先；dev fallback 走 tsx）
  const distEntry = path.join(PATHS.DIST, 'daemon', 'index.js');
  const srcEntry = path.join(PATHS.SRC, 'daemon', 'index.ts');
  let cmd: string;
  let args: string[];
  if (fs.existsSync(distEntry)) {
    cmd = process.execPath;
    args = [distEntry];
  } else {
    const tsxBin = path.join(PATHS.ROOT, 'node_modules', '.bin', 'tsx');
    cmd = process.execPath;
    args = [tsxBin, srcEntry];
  }

  // 3. spawn detached
  let child;
  try {
    child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      shell: false,
      cwd: PATHS.ROOT,
      env: process.env,
    });
    child.unref();
    trace(`spawned pid=${child.pid} cmd=${cmd} entry=${args[args.length - 1]}`);
  } catch (e) {
    return { ok: false, error: `spawn failed: ${(e as Error).message}` };
  }

  // 4. 轮询等 pipe
  const timeoutMs = opts.timeoutMs ?? 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    if (fs.existsSync(pipe)) {
      try {
        fs.writeFileSync(PATHS.PID_FILE, String(child.pid), 'utf8');
      } catch {
        /* ignore */
      }
      trace(`ready, ipc=${pipe}`);
      return { ok: true, pid: child.pid, ipcPipe: pipe };
    }
    // 子进程提前死？
    if (child.exitCode !== null) {
      return {
        ok: false,
        error: `daemon exited early with code ${child.exitCode} (try running it in foreground: npm run start:daemon)`,
      };
    }
  }
  return { ok: false, error: `timeout waiting for IPC pipe at ${pipe}` };
}
