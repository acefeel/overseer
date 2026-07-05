import { spawn } from 'node:child_process';
import type { Scanner, ScannerContext, IntentionSeed } from './base.js';
import { nowIso } from './base.js';
import { readManifest } from '../projects/manifest.js';

/**
 * 跑项目的 testCommand 并解析失败。testCommand 为空时 skip。
 * expensive（要真的跑测试）。
 */
export class TestScanner implements Scanner {
  readonly id = 'test';
  readonly description = '运行 manifest.testCommand 检测测试失败';
  readonly cost = 'expensive' as const;

  async scan(ctx: ScannerContext): Promise<IntentionSeed[]> {
    if (!ctx.allowShell) return [];
    const manifest = readManifest(ctx.project.rootAbs);
    if (!manifest.testCommand) return [];

    const p = ctx.project.id;
    const t = nowIso();

    const result = await this.run(manifest.testCommand, ctx.project.rootAbs, 120_000);
    if (result.code === 0) return [];

    const tail = result.stdout.split('\n').slice(-30).join('\n');
    return [
      {
        key: `test:fail:${p}`,
        project: p,
        source: 'test',
        category: 'bug',
        severity: 'high',
        title: `${p} 测试失败（exit ${result.code}）`,
        detail: `命令：\`${manifest.testCommand}\`\n\n输出尾部：\n\`\`\`\n${tail}\n\`\`\``,
        hint: '先在本地复现；按失败信息定位；红测优先于新功能',
        detectedAt: t,
      },
    ];
  }

  private run(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const child = spawn(cmd, {
        cwd,
        shell: isWin ? 'cmd.exe' : '/bin/sh',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr });
      });
    });
  }
}
