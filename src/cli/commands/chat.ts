import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { loadConfig } from '../../util/config.js';
import { Supervisor } from '../../daemon/supervisor.js';
import { IpcClient } from '../../daemon/ipc.js';

export async function runChat(initial?: string): Promise<void> {
  const cfg = loadConfig();
  const mainReady = !!cfg.providers[cfg.router.chain[0]]?.apiKey;
  let fallbackUsable = false;
  try {
    const { HealthProbe } = await import('../../providers/health.js');
    const probe = new HealthProbe(cfg, 0);
    fallbackUsable = await probe.fallbackUsable();
  } catch {
    /* ignore */
  }

  if (!mainReady && !fallbackUsable) {
    console.log(chalk.red('\n⚠ 既没有可用的主控 apiKey，本地 fallback 也没起来。'));
    console.log(chalk.gray('  修复路径（任选其一）：'));
    console.log(chalk.gray('  1) 编辑 ') + chalk.cyan('config/.secrets.yaml') + chalk.gray(' 填入 GLM key'));
    console.log(chalk.gray('  2) 设置环境变量 ') + chalk.cyan('OVERSEER_GLM_API_KEY'));
    console.log(chalk.gray('  3) 启用本地 fallback（providers.local.enabled + Ollama 在跑）'));
    return;
  }

  const modeTag = !mainReady && fallbackUsable
    ? chalk.magenta(' [degraded: 仅本地 fallback 可用]')
    : '';
  console.log(chalk.bold.cyan(`\n=== overSeer chat ===${modeTag}`));
  console.log(chalk.gray('输入消息回车发送，"exit" 或 Ctrl+C 退出。\n'));

  const ipc = new IpcClient(cfg.daemon.ipcName);
  const daemonAlive = await ipc.isAlive().catch(() => false);
  const localSup = daemonAlive ? null : new Supervisor();

  const sendOnce = async (text: string): Promise<void> => {
    try {
      let res: {
        reply: string;
        model: string;
        provider: string;
        retrievedNotes?: number;
        memoryWritten?: { type: string; rel: string } | null;
      };
      if (daemonAlive) {
        res = await ipc.request('chat', { text });
      } else {
        res = await localSup!.chat(text);
      }
      const parts: string[] = [];
      if (res.provider !== '-') {
        parts.push(chalk.gray(`[${res.provider}/${res.model}]`));
      }
      if (res.retrievedNotes && res.retrievedNotes > 0) {
        parts.push(chalk.gray(`📖 recalled ${res.retrievedNotes}`));
      }
      if (res.memoryWritten) {
        parts.push(chalk.cyan(`📝 ${res.memoryWritten.type}→[[${res.memoryWritten.rel}]]`));
      }
      const usageLine = parts.length ? '  ' + parts.join(' ') : '';
      console.log(chalk.green('\noverSeer:') + ' ' + res.reply + usageLine + '\n');
    } catch (e) {
      console.log(chalk.red(`\n错误: ${(e as Error).message}\n`));
    }
  };

  if (initial) {
    await sendOnce(initial);
    return;
  }

  while (true) {
    let text: string;
    try {
      text = await input({ message: chalk.blue('you>'), default: '' });
    } catch {
      break;
    }
    if (!text) continue;
    if (['exit', 'quit', ':q'].includes(text.trim().toLowerCase())) {
      console.log(chalk.gray('bye.'));
      break;
    }
    await sendOnce(text);
  }
}
