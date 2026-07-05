import fs from 'node:fs';
import { launchDaemon } from '../dist/daemon/launcher.js';
import { IpcClient } from '../dist/daemon/ipc.js';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + JSON.stringify(detail)}`);
  if (cond) pass++; else fail++;
}

// 0. 确保 daemon 没在跑
console.log('=== 0. 清场：杀掉任何残留 daemon ===');
import { PATHS } from '../dist/util/paths.js';
if (fs.existsSync(PATHS.PID_FILE)) {
  const pid = Number(fs.readFileSync(PATHS.PID_FILE, 'utf8').trim());
  if (pid) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  fs.unlinkSync(PATHS.PID_FILE);
}
await new Promise(r => setTimeout(r, 500));
console.log('PID 文件存在:', fs.existsSync(PATHS.PID_FILE));

console.log('\n=== 1. launchDaemon 从零启动 ===');
const t0 = Date.now();
const r1 = await launchDaemon('overseer', { timeoutMs: 10000 });
const ms = Date.now() - t0;
check('launchDaemon 返回 ok', r1.ok, r1);
check('返回 pid', typeof r1.pid === 'number' && r1.pid > 0, r1.pid);
check('不是 alreadyRunning', r1.alreadyRunning !== true, r1);
check('返回 ipcPipe', typeof r1.ipcPipe === 'string', r1.ipcPipe);
check(`启动耗时 < 5s (实际 ${ms}ms)`, ms < 5000, ms);

console.log('\n=== 2. PID 文件 + 进程存活 ===');
const pidFromFile = Number(fs.readFileSync(PATHS.PID_FILE, 'utf8').trim());
check('PID 文件写了', pidFromFile === r1.pid, { file: pidFromFile, returned: r1.pid });
let procAlive;
try { process.kill(r1.pid, 0); procAlive = true; } catch { procAlive = false; }
check('进程存活', procAlive, r1.pid);

console.log('\n=== 3. IPC 真的能 ping ===');
const c = new IpcClient('overseer');
const ping = await c.request('ping');
check('ping 返回 pong', ping.pong === true, ping);

console.log('\n=== 4. 重复调 launchDaemon 应该检测到已在跑 ===');
const r2 = await launchDaemon('overseer', { timeoutMs: 3000 });
check('返回 ok', r2.ok, r2);
check('alreadyRunning=true', r2.alreadyRunning === true, r2);
check('pid 一致', r2.pid === r1.pid, { first: r1.pid, second: r2.pid });

console.log('\n=== 5. shutdown IPC 干净退出 ===');
const shutR = await c.request('shutdown');
check('shutdown 返回 ok', shutR.ok === true, shutR);
await new Promise(r => setTimeout(r, 1000));
let aliveAfter;
try { process.kill(r1.pid, 0); aliveAfter = true; } catch { aliveAfter = false; }
check('进程已退', !aliveAfter, { pid: r1.pid });
check('PID 文件已清', !fs.existsSync(PATHS.PID_FILE), PATHS.PID_FILE);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
