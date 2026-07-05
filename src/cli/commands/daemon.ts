import chalk from 'chalk';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig } from '../../util/config.js';
import { PATHS } from '../../util/paths.js';
import { launchDaemon } from '../../daemon/launcher.js';

export async function runDaemon(action: string): Promise<void> {
  const cfg = loadConfig();
  switch (action) {
    case 'start':
      await startDaemon(cfg.daemon.ipcName);
      break;
    case 'stop':
      await stopDaemon(cfg.daemon.ipcName);
      break;
    case 'restart':
      await stopDaemon(cfg.daemon.ipcName, true);
      await startDaemon(cfg.daemon.ipcName);
      break;
    case 'status':
      await daemonStatus(cfg.daemon.ipcName);
      break;
    default:
      console.log(chalk.red(`unknown daemon action: ${action}`));
      console.log(chalk.gray('usage: overseer daemon <start|stop|restart|status>'));
      process.exit(2);
  }
}

async function startDaemon(ipcName: string): Promise<void> {
  const trace = (m: string) => {
    if (m.startsWith('spawned')) return; // 静默
  };
  const r = await launchDaemon(ipcName, { timeoutMs: 10000, logger: trace });
  if (!r.ok) {
    console.log(chalk.red(`✗ daemon 启动失败：${r.error}`));
    console.log(chalk.gray('  尝试前台跑看错误：npm run start:daemon'));
    process.exit(1);
  }
  if (r.alreadyRunning) {
    console.log(chalk.yellow(`daemon already running (pid ${r.pid})`));
    return;
  }
  console.log(chalk.green(`daemon started (pid ${r.pid}, ipc ${r.ipcPipe})`));
}

async function stopDaemon(_ipcName: string, silent = false): Promise<void> {
  if (!fs.existsSync(PATHS.PID_FILE)) {
    if (!silent) console.log(chalk.gray('no daemon running (no pid file)'));
    return;
  }
  const pidStr = fs.readFileSync(PATHS.PID_FILE, 'utf8').trim();
  const pid = Number(pidStr);
  if (!pid) {
    if (!silent) console.log(chalk.gray('no valid pid'));
    fs.unlinkSync(PATHS.PID_FILE);
    return;
  }
  if (await isPidAlive(pid)) {
    process.kill(pid, os.platform() === 'win32' ? undefined : 'SIGTERM');
    if (!silent) console.log(chalk.yellow(`stopping daemon pid ${pid}...`));
    let attempts = 0;
    while (attempts++ < 20) {
      await new Promise((r) => setTimeout(r, 200));
      if (!(await isPidAlive(pid))) break;
    }
    if (await isPidAlive(pid)) {
      try {
        process.kill(pid, os.platform() === 'win32' ? 9 : 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
  try {
    fs.unlinkSync(PATHS.PID_FILE);
  } catch {
    /* ignore */
  }
  if (!silent) console.log(chalk.green('daemon stopped'));
}

async function daemonStatus(_ipcName: string): Promise<void> {
  if (!fs.existsSync(PATHS.PID_FILE)) {
    console.log(chalk.gray('daemon: not started'));
    return;
  }
  const pidStr = fs.readFileSync(PATHS.PID_FILE, 'utf8').trim();
  const pid = Number(pidStr);
  const alive = await isPidAlive(pid);
  console.log(
    `daemon: ${alive ? chalk.green('running') : chalk.gray('dead/stale')}  pid=${pid}`
  );
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
