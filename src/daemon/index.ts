import fs from 'node:fs';
import { loadConfig } from '../util/config.js';
import { getLogger } from '../util/logger.js';
import { PATHS, ensureDataDirs } from '../util/paths.js';
import { IpcServer } from './ipc.js';
import { Supervisor } from './supervisor.js';
import { TaskLoop } from './taskloop.js';
import { HealthProbe } from '../providers/health.js';

async function main(): Promise<void> {
  ensureDataDirs();
  const cfg = loadConfig();
  const log = getLogger('daemon');

  fs.writeFileSync(PATHS.PID_FILE, String(process.pid), 'utf8');

  const sup = new Supervisor();
  const ipc = new IpcServer(cfg.daemon.ipcName, sup.ipcHandler());
  await ipc.listen();

  const taskLoop = new TaskLoop({
    router: sup.router,
    modePolicy: sup.modePolicy,
    budget: sup.budget,
    writer: sup.writer,
    currentMode: () => sup.mode,
    recomputeMode: () => sup.recomputeMode(),
  });
  sup.setTaskLoop(taskLoop);
  taskLoop.start();

  const health = new HealthProbe(cfg);
  health.checkAll().catch((e) => log.warn({ err: String(e) }, 'startup health probe failed'));
  const healthTimer = setInterval(() => {
    health.checkAll().catch(() => {});
  }, 5 * 60_000);

  log.info(
    { pid: process.pid, mode: sup.mode, worker: sup.router.hasWorker(), consultant: sup.router.hasConsultant() },
    'overSeer daemon ready (M5 worker/consultant task loop engaged)'
  );

  const cleanup = async (sig: string) => {
    log.info({ sig }, 'shutting down');
    await taskLoop.stop();
    clearInterval(healthTimer);
    try {
      fs.unlinkSync(PATHS.PID_FILE);
    } catch {
      /* ignore */
    }
    await ipc.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void cleanup('SIGINT'));
  process.on('SIGTERM', () => void cleanup('SIGTERM'));
}

main().catch((e) => {
  const log = getLogger('daemon');
  log.error({ err: String(e), stack: (e as Error).stack }, 'daemon fatal');
  process.exit(1);
});
