import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { ActionExecutor } from '../src/supervisor/actions.js';
import { ModePolicy } from '../src/daemon/mode.js';
import type { ProjectInfo } from '../src/projects/scanner.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-action-'));
}

function initGit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n', 'utf8');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: dir, stdio: 'ignore' });
}

function project(dir: string): ProjectInfo {
  return {
    id: path.basename(dir),
    name: path.basename(dir),
    rootAbs: dir,
    relPath: path.basename(dir),
    isGitRepo: true,
    hasManifest: false,
    detectedBy: ['git'],
  };
}

describe('ActionExecutor', () => {
  let dir: string;
  let executor: ActionExecutor;

  beforeEach(() => {
    dir = tmpDir();
    initGit(dir);
    fs.writeFileSync(path.join(dir, '.overseer.json'), JSON.stringify({
      version: 1,
      allowWrite: true,
      allowExec: ['echo'],
      protectedPaths: ['config/**'],
    }), 'utf8');
    executor = new ActionExecutor(project(dir), new ModePolicy(), () => 'normal');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writeFile 创建文件并打 snapshot', async () => {
    const r = await executor.writeFile('src/foo.ts', 'export const X = 1;\n');
    expect(r.ok).toBe(true);
    expect(r.snapshot).toBeDefined();
    expect(fs.existsSync(path.join(dir, 'src', 'foo.ts'))).toBe(true);
  });

  it('写入受保护路径被拒绝', async () => {
    const r = await executor.writeFile('config/secrets.yaml', 'key: leak\n');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('protected');
  });

  it('allowWrite=false 拒绝写入', async () => {
    fs.writeFileSync(path.join(dir, '.overseer.json'), JSON.stringify({ allowWrite: false }), 'utf8');
    const r = await executor.writeFile('src/foo.ts', 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('allowWrite=false');
  });

  it('runShell 执行白名单命令', async () => {
    const r = await executor.runShell('echo hello');
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('hello');
    expect(r.snapshot).toBeDefined();
  });

  it('runShell 非白名单命令创建 approval', async () => {
    const r = await executor.runShell('npm test');
    expect(r.ok).toBe(false);
    expect(r.approval?.status).toBe('pending');
    expect(r.error).toContain('approval');
  });

  it('gitCommit 提交改动', async () => {
    fs.writeFileSync(path.join(dir, 'new.md'), 'new', 'utf8');
    const r = await executor.gitCommit('add new file');
    expect(r.ok).toBe(true);
    const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' }).trim();
    expect(status).toBe('');
    const tracked = execSync('git ls-files new.md', { cwd: dir, encoding: 'utf8' }).trim();
    expect(tracked).toBe('new.md');
  });

  it('stopped 模式拒绝写动作', async () => {
    const stoppedExecutor = new ActionExecutor(project(dir), new ModePolicy(), () => 'stopped');
    const r = await stoppedExecutor.writeFile('src/foo.ts', 'x');
    expect(r.ok).toBe(false);
    expect(r.error?.toLowerCase()).toContain('stopped');
  });

  it('deleteFile 删除文件并打 snapshot', async () => {
    const target = path.join(dir, 'src', 'old.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export const OLD = 1;\n', 'utf8');
    expect(fs.existsSync(target)).toBe(true);

    const r = await executor.deleteFile('src/old.ts');
    expect(r.ok).toBe(true);
    expect(r.snapshot).toBeDefined();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('deleteFile 删除不存在的文件返回错误', async () => {
    const r = await executor.deleteFile('src/never-existed.ts');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
  });

  it('deleteFile 拒绝删除受保护路径', async () => {
    const target = path.join(dir, 'config', 'secrets.yaml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'key: leak\n', 'utf8');
    const r = await executor.deleteFile('config/secrets.yaml');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('protected');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('allowWrite=false 拒绝删除', async () => {
    const target = path.join(dir, 'src', 'old.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x', 'utf8');
    fs.writeFileSync(path.join(dir, '.overseer.json'), JSON.stringify({ allowWrite: false }), 'utf8');
    const r = await executor.deleteFile('src/old.ts');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('allowWrite=false');
    expect(fs.existsSync(target)).toBe(true);
  });
});
