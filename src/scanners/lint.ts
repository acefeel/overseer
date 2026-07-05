import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Scanner, ScannerContext, IntentionSeed } from './base.js';
import { nowIso } from './base.js';

const LINT_CONFIG_FILES = [
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc.json',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.stylelintrc',
  '.stylelintrc.json',
  '.stylelintrc.yaml',
  '.stylelintrc.yml',
  '.stylelintrc.js',
  'stylelint.config.js',
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.js',
  'prettier.config.js',
];

interface LintConfig {
  hasLintScript: boolean;
  hasEslintConfig: boolean;
  hasStylelintConfig: boolean;
  hasPrettierConfig: boolean;
}

export class LintScanner implements Scanner {
  readonly id = 'lint' as const;
  readonly description = '检测 lint 配置与执行结果';
  readonly cost = 'medium' as const;

  async scan(ctx: ScannerContext): Promise<IntentionSeed[]> {
    const root = ctx.project.rootAbs;
    const cfg = this.detectConfig(root);
    const p = ctx.project.id;
    const t = nowIso();

    if (!cfg.hasLintScript && !cfg.hasEslintConfig && !cfg.hasStylelintConfig && !cfg.hasPrettierConfig) {
      return [];
    }

    if (!ctx.allowShell) {
      return [this.configOnlySeed(cfg, p, t)];
    }

    // allowShell=true：优先跑 npm run lint
    if (cfg.hasLintScript) {
      const result = await this.runNpmRunLint(root);
      return this.seedsFromResult(cfg, p, t, result);
    }

    // 没有 lint 脚本但存在 eslint 配置：尝试 npx eslint
    if (cfg.hasEslintConfig) {
      const result = await this.runEslint(root);
      return this.seedsFromResult(cfg, p, t, result);
    }

    // 其他配置（stylelint/prettier）只做配置检测
    return [this.configOnlySeed(cfg, p, t)];
  }

  private detectConfig(root: string): LintConfig {
    const out: LintConfig = {
      hasLintScript: false,
      hasEslintConfig: false,
      hasStylelintConfig: false,
      hasPrettierConfig: false,
    };

    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as Record<string, any>;
        out.hasLintScript = typeof pkg.scripts?.lint === 'string';
      } catch {
        /* ignore */
      }
    }

    for (const f of LINT_CONFIG_FILES) {
      if (fs.existsSync(path.join(root, f))) {
        if (f.includes('eslint')) out.hasEslintConfig = true;
        if (f.includes('stylelint')) out.hasStylelintConfig = true;
        if (f.includes('prettier')) out.hasPrettierConfig = true;
      }
    }

    return out;
  }

  private configOnlySeed(cfg: LintConfig, project: string, detectedAt: string): IntentionSeed {
    const parts: string[] = [];
    if (cfg.hasEslintConfig) parts.push('ESLint');
    if (cfg.hasStylelintConfig) parts.push('Stylelint');
    if (cfg.hasPrettierConfig) parts.push('Prettier');
    if (cfg.hasLintScript) parts.push('lint 脚本');

    return {
      key: 'lint:config',
      project,
      source: 'lint',
      category: 'hygiene',
      severity: 'low',
      title: `${project} 检测到 lint 配置（${parts.join('/') }）`,
      detail: `项目存在 ${parts.join('、')}，但未在本次扫描中执行。` +
        '如需让 overSeer 运行 lint 并产出改进建议，可在 cycle/scan 时传入 --allow-shell。',
      hint: '允许 shell 后重新扫描，或手动运行 lint 查看问题',
      detectedAt,
    };
  }

  private async runNpmRunLint(root: string): Promise<{ ok: boolean; errorCount: number; warningCount: number; output: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('npm', ['run', 'lint'], { cwd: root, shell: true });
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        resolve({ ok: false, errorCount: 0, warningCount: 0, output: err.message });
      });
      child.on('close', (code) => {
        const output = stdout + stderr;
        // npm run lint 退出码非 0 通常表示 lint 发现问题
        // 简单估计：从输出里数 error/warning 行数
        const errors = (output.match(/error/gi) || []).length;
        const warnings = (output.match(/warning/gi) || []).length;
        resolve({
          ok: code === 0,
          errorCount: errors,
          warningCount: warnings,
          output: output.slice(0, 2000),
        });
      });
    });
  }

  private async runEslint(root: string): Promise<{ ok: boolean; errorCount: number; warningCount: number; output: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('npx', ['eslint', '.', '--format', 'json'], { cwd: root, shell: true });
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        resolve({ ok: false, errorCount: 0, warningCount: 0, output: err.message });
      });
      child.on('close', () => {
        const output = stdout + stderr;
        let errorCount = 0;
        let warningCount = 0;
        try {
          const arr = JSON.parse(stdout) as Array<{ errorCount: number; warningCount: number }>;
          for (const item of arr) {
            errorCount += item.errorCount ?? 0;
            warningCount += item.warningCount ?? 0;
          }
        } catch {
          // 解析失败则按文本估计
          errorCount = (output.match(/error/gi) || []).length;
          warningCount = (output.match(/warning/gi) || []).length;
        }
        resolve({
          ok: errorCount === 0,
          errorCount,
          warningCount,
          output: output.slice(0, 2000),
        });
      });
    });
  }

  private seedsFromResult(
    cfg: LintConfig,
    project: string,
    detectedAt: string,
    result: { ok: boolean; errorCount: number; warningCount: number; output: string }
  ): IntentionSeed[] {
    const out: IntentionSeed[] = [];

    if (!result.ok || result.errorCount > 0 || result.warningCount > 0) {
      const total = result.errorCount + result.warningCount;
      const severity: IntentionSeed['severity'] = result.errorCount > 0 ? 'high' : 'medium';
      out.push({
        key: 'lint:issues',
        project,
        source: 'lint',
        category: 'tech-debt',
        severity,
        title: `${project} lint 发现 ${total} 个问题（error ${result.errorCount}, warning ${result.warningCount}）`,
        detail: `执行结果：\n${result.output.slice(0, 1200)}\n\n建议先修复 error，再处理 warning。`,
        hint: '运行 lint --fix 或按报告逐项修复',
        detectedAt,
      });
    }

    // 同时保留一条 hygiene 配置提示
    out.push(this.configOnlySeed(cfg, project, detectedAt));

    return out;
  }
}
