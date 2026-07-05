#!/usr/bin/env node
import { Command } from 'commander';
import { runStatus } from './commands/status.js';
import { runChat } from './commands/chat.js';
import { runDaemon } from './commands/daemon.js';
import { runKb } from './commands/kb.js';
import { runProjects } from './commands/projects.js';
import { runSupervise } from './commands/supervise.js';
import { runQueue, runCycle, runHealth } from './commands/autonomy.js';
import { runDoctor } from './commands/doctor.js';
import { runTui } from './commands/tui.js';

const program = new Command();

program
  .name('overseer')
  .description('overSeer —— 有预算意识的开发监理 agent')
  .version('0.1.0');

program
  .command('status')
  .description('查看健康/预算/Provider/模式 状态')
  .action(() => runStatus());

program
  .command('chat [message]')
  .description('与 overSeer 聊天（不传 message 进入交互式 REPL）')
  .action((message?: string) => runChat(message));

program
  .command('tui')
  .description('启动全屏 TUI dashboard（实时 mode/budget/queue/activity）')
  .action(() => runTui());

program
  .command('daemon <action>')
  .description('管理常驻 daemon：start | stop | restart | status')
  .action((action: string) => runDaemon(action));

program
  .command('kb <action> [args...]')
  .description('知识库：search <q> | show <relpath> | recent [--type T] [--limit N] | write ... | stats')
  .allowUnknownOption(true)
  .action((action: string, args: string[]) => runKb(action, args));

program
  .command('projects <action> [args...]')
  .description('项目：list | show <id> | init <id> [--allow-write] [--test cmd] | status <id>')
  .allowUnknownOption(true)
  .action((action: string, args: string[]) => runProjects(action, args));

program
  .command('supervise <action> [args...]')
  .description('监理：plan | intentions | intention | develop | snapshots | snapshot | rollback | approvals | approve | reject')
  .allowUnknownOption(true)
  .action((action: string, args: string[]) => runSupervise(action, args));

program
  .command('queue <action> [args...]')
  .description('自主巡检队列：list | stats | show <id> | drop <id> | clear [--project X] | pick [--project X]')
  .allowUnknownOption(true)
  .action((action: string, args: string[]) => runQueue(action, args));

program
  .command('cycle <action> [args...]')
  .description('自主巡检：run | log [--limit N] | scan <project> [--aggressiveness L|N|F] [--allow-shell]')
  .allowUnknownOption(true)
  .action((action: string, args: string[]) => runCycle(action, args));

program
  .command('health')
  .description('探测 provider（特别是 Ollama fallback）真实可达性')
  .action(() => runHealth());

program
  .command('doctor')
  .description('自检：配置、目录、provider、git、vault、项目扫描')
  .action(() => runDoctor());

program.parseAsync(process.argv).catch((e) => {
  console.error('overseer:', (e as Error).message);
  process.exit(1);
});
