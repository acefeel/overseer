import { IpcClient } from '../dist/daemon/ipc.js';
import fs from 'node:fs';

const pidFile = 'data/daemon.pid';
const pidBefore = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '(none)';
console.log('daemon pid before:', pidBefore);

const c = new IpcClient('overseer');
console.log('sending shutdown…');
const resp = await c.request('shutdown');
console.log('response:', resp);

await new Promise((r) => setTimeout(r, 1500));

const alive = await c.isAlive().catch(() => false);
console.log('alive after shutdown:', alive);

const pidAfter = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '(cleaned)';
console.log('pid file after:', pidAfter);

process.exit(0);
