import chalk from 'chalk';
import { input } from '@inquirer/prompts';
import { loadConfig } from '../../util/config.js';
import { Supervisor } from '../../daemon/supervisor.js';
import { IpcClient } from '../../daemon/ipc.js';

interface ChatResponse {
  reply: string;
  model: string;
  provider: string;
  retrievedNotes?: number;
  memoryWritten?: { type: string; rel: string } | null;
  needsConfirmation?: boolean;
  pendingTool?: { tool: string; args: Record<string, unknown>; summary: string };
}

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
  console.log(chalk.gray('输入消息回车发送，"exit" 或 Ctrl+C 退出。'));
  console.log(chalk.gray('支持自然语言指令，例如："查看状态"、"暂停任务循环"、"列出队列"。\n'));

  const ipc = new IpcClient(cfg.daemon.ipcName);
  const daemonAlive = await ipc.isAlive().catch(() => false);
  const localSup = daemonAlive ? null : new Supervisor();

  const sendOnce = async (text: string, confirmTool?: ChatResponse['pendingTool']): Promise<ChatResponse> => {
    try {
      const payload: { text: string; confirmTool?: ChatResponse['pendingTool'] } = { text };
      if (confirmTool) payload.confirmTool = confirmTool;
      let res: ChatResponse;
      if (daemonAlive) {
        res = await ipc.request('chat', payload);
      } else {
        const opts: { confirmTool?: ChatResponse['pendingTool'] } = {};
        if (confirmTool) opts.confirmTool = confirmTool;
        res = await localSup!.chat(text, opts as any);
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
      return res;
    } catch (e) {
      console.log(chalk.red(`\n错误: ${(e as Error).message}\n`));
      return { reply: '', model: '-', provider: '-', needsConfirmation: false };
    }
  };

  if (initial) {
    const res = await sendOnce(initial);
    if (res.needsConfirmation && res.pendingTool) {
      const ok = await askConfirm(res.pendingTool.summary);
      if (ok) await sendOnce('确认', res.pendingTool);
    }
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
    const res = await sendOnce(text);
    if (res.needsConfirmation && res.pendingTool) {
      const ok = await askConfirm(res.pendingTool.summary);
      if (ok) await sendOnce('确认', res.pendingTool);
    }
  }
}

async function askConfirm(summary: string): Promise<boolean> {
  console.log(chalk.yellow(`⚠ 待确认操作：${summary}`));
  const answer = await input({ message: chalk.blue('确认执行? (yes/no):'), default: '' });
  const t = answer.trim().toLowerCase();
  return t === 'yes' || t === 'y' || t === '确认';
}
