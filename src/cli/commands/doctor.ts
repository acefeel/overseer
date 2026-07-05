import chalk from 'chalk';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, AppConfigSchema, isProviderReady } from '../../util/config.js';
import { PATHS } from '../../util/paths.js';
import { Router } from '../../providers/router.js';
import { HealthProbe } from '../../providers/health.js';
import { Vault } from '../../kb/vault.js';
import { scanProjects } from '../../projects/scanner.js';
import { execSync } from 'node:child_process';

interface Check {
  name: string;
  ok: boolean;
  message: string;
  fix?: string;
}

export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // 1. Node 版本
  const nodeVersion = process.version;
  const nodeMajor = Number(nodeVersion.slice(1).split('.')[0]);
  checks.push({
    name: 'Node.js 版本',
    ok: nodeMajor >= 20,
    message: nodeVersion,
    fix: '升级到 Node.js >= 20',
  });

  // 2. 依赖安装
  let depsOk = fs.existsSync(path.join(PATHS.ROOT, 'node_modules', 'commander', 'package.json'));
  checks.push({
    name: '依赖安装',
    ok: depsOk,
    message: depsOk ? 'node_modules 存在' : 'node_modules 缺失',
    fix: '运行 npm install',
  });

  // 3. 配置文件可解析
  try {
    loadConfig({ force: true });
    checks.push({ name: '配置解析', ok: true, message: 'overseer.config.yaml 可解析' });
  } catch (e) {
    checks.push({
      name: '配置解析',
      ok: false,
      message: `配置解析失败: ${(e as Error).message}`,
      fix: '检查 config/overseer.config.yaml 与 .secrets.yaml 的 YAML 语法',
    });
  }

  // 4. 目录权限
  const dirsOk = ensureDirs();
  checks.push({
    name: '运行时目录',
    ok: dirsOk,
    message: dirsOk ? 'data/ 与 logs/ 可写' : '无法创建 data/ 或 logs/',
    fix: '检查项目根目录写权限',
  });

  // 5. vault 可写
  let vaultOk = false;
  let vaultMsg = '';
  try {
    const vault = new Vault();
    vault.ensure();
    const testFile = path.join(vault.rootAbs, '.overseer-doctor-test');
    fs.writeFileSync(testFile, 'ok', 'utf8');
    fs.unlinkSync(testFile);
    vaultOk = true;
    vaultMsg = `vault root ${path.relative(PATHS.ROOT, vault.rootAbs)} 可写`;
  } catch (e) {
    vaultMsg = `vault 不可写: ${(e as Error).message}`;
  }
  checks.push({
    name: 'Vault 可写',
    ok: vaultOk,
    message: vaultMsg,
    fix: '检查 vault/ 目录写权限，或调整配置 vault.root',
  });

  // 6. provider ready
  let providerOk = false;
  let providerMsg = '';
  const providerChecks: { id: string; ready: boolean; reachable: boolean; hasKey: boolean }[] = [];
  try {
    const cfg = loadConfig();
    const router = new Router(cfg);
    const probe = new HealthProbe(cfg, 0);
    const all = await probe.checkAll();
    providerChecks.push(
      ...all.map((h) => ({
        id: h.id,
        ready: h.ready,
        reachable: h.reachable,
        hasKey: isProviderReady(h.id),
      }))
    );
    providerOk = router.mainChainReady() || router.hasFallback();
    const mainReady = router.mainChainReady();
    const fbReady = router.hasFallback();
    providerMsg = `主链 ready=${mainReady}, fallback ready=${fbReady}`;
  } catch (e) {
    providerMsg = `provider 检查失败: ${(e as Error).message}`;
  }
  const failedProviders = providerChecks.filter((p) => !p.ready);
  checks.push({
    name: 'Provider 可用性',
    ok: providerOk,
    message: providerMsg,
    fix: failedProviders.length > 0
      ? failedProviders
          .map((p) => {
            if (!p.hasKey && p.id !== 'local') return `${p.id}: 缺少 apiKey（环境变量 OVERSEER_${p.id.toUpperCase()}_API_KEY 或 .secrets.yaml）`;
            if (p.id === 'local' && !p.reachable) return `${p.id}: Ollama 未运行（http://localhost:11434/v1）`;
            return `${p.id}: ready=${p.ready}, reachable=${p.reachable}`;
          })
          .join('; ') || '配置 apiKey 或启用 local fallback'
      : '检查 providers 配置',
  });

  // 7. git 可用
  let gitOk = false;
  let gitMsg = '';
  try {
    const v = execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    gitOk = true;
    gitMsg = v;
  } catch (e) {
    gitMsg = `git 不可用: ${(e as Error).message}`;
  }
  checks.push({
    name: 'Git CLI',
    ok: gitOk,
    message: gitMsg,
    fix: '安装 git 并确保它在 PATH 中',
  });

  // 8. 项目扫描
  let projectsOk = false;
  let projectsMsg = '';
  try {
    const projects = scanProjects();
    projectsOk = projects.length > 0;
    projectsMsg = `扫描到 ${projects.length} 个项目`;
  } catch (e) {
    projectsMsg = `项目扫描失败: ${(e as Error).message}`;
  }
  checks.push({
    name: '项目扫描',
    ok: projectsOk,
    message: projectsMsg,
    fix: '检查 workspace.root 配置与目录权限',
  });

  // 9. schema 校验
  let schemaOk = false;
  let schemaMsg = '';
  try {
    const cfg = loadConfig();
    AppConfigSchema.parse(cfg);
    schemaOk = true;
    schemaMsg = '配置通过 zod schema 校验';
  } catch (e) {
    schemaMsg = `schema 校验失败: ${(e as Error).message}`;
  }
  checks.push({
    name: '配置 Schema',
    ok: schemaOk,
    message: schemaMsg,
    fix: '对照 config/.secrets.example.yaml 与 AGENTS.md 第 5 节检查字段',
  });

  // 10. 密钥文件未误提交（git status 检查）
  let secretSafe = true;
  let secretMsg = '.secrets.yaml 不在 git 跟踪中';
  try {
    const tracked = execSync('git ls-files config/.secrets.yaml', {
      encoding: 'utf8',
      cwd: PATHS.ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (tracked) {
      secretSafe = false;
      secretMsg = '警告：config/.secrets.yaml 已被 git 跟踪，存在泄漏风险';
    }
  } catch {
    /* 可能不是 git 仓库 */
  }
  checks.push({
    name: '密钥安全',
    ok: secretSafe,
    message: secretMsg,
    fix: '运行 git rm --cached config/.secrets.yaml 并确认 .gitignore 包含它',
  });

  // 输出
  console.log(chalk.bold.cyan('\n=== overSeer doctor ===\n'));
  let okCount = 0;
  for (const c of checks) {
    const icon = c.ok ? chalk.green('✓') : chalk.red('✗');
    const name = chalk.bold(c.name);
    console.log(`${icon} ${name}: ${c.message}`);
    if (!c.ok && c.fix) {
      console.log(`  ${chalk.gray('→ 修复建议:')} ${c.fix}`);
    }
    if (c.ok) okCount++;
  }
  console.log();
  console.log(`结果: ${okCount}/${checks.length} 项通过`);

  if (okCount < checks.length) {
    process.exit(1);
  }
}

function ensureDirs(): boolean {
  try {
    if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
    if (!fs.existsSync(PATHS.LOG_DIR)) fs.mkdirSync(PATHS.LOG_DIR, { recursive: true });
    const df = path.join(PATHS.DATA_DIR, '.doctor-write-test');
    const lf = path.join(PATHS.LOG_DIR, '.doctor-write-test');
    fs.writeFileSync(df, 'ok');
    fs.writeFileSync(lf, 'ok');
    fs.unlinkSync(df);
    fs.unlinkSync(lf);
    return true;
  } catch {
    return false;
  }
}
