import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fulfill } from '../src/supervisor/fulfill.js';
import * as approvals from '../src/supervisor/approvals.js';
import { PATHS } from '../src/util/paths.js';

const APPROVAL_FILE = path.join(PATHS.DATA_DIR, 'approvals.json');
let backup: Buffer | null = null;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-fulfill-'));
}

function initGit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n', 'utf8');
  execSync('git add .', { cwd: dir, stdio: 'ignore' });
  execSync('git commit -m init', { cwd: dir, stdio: 'ignore' });
}

describe('fulfill (file.delete 审批闭环)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    initGit(dir);
    fs.writeFileSync(path.join(dir, '.overseer.json'), JSON.stringify({
      version: 1,
      allowWrite: true,
      protectedPaths: ['config/**'],
    }), 'utf8');
    if (fs.existsSync(APPROVAL_FILE)) {
      backup = fs.readFileSync(APPROVAL_FILE);
    } else {
      backup = null;
    }
    if (!fs.existsSync(PATHS.DATA_DIR)) fs.mkdirSync(PATHS.DATA_DIR, { recursive: true });
    fs.writeFileSync(APPROVAL_FILE, '[]', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (backup === null) {
      if (fs.existsSync(APPROVAL_FILE)) fs.unlinkSync(APPROVAL_FILE);
    } else {
      fs.writeFileSync(APPROVAL_FILE, backup);
    }
  });

  it('approved file.delete → 实际删除文件', async () => {
    const target = path.join(dir, 'src', 'stale.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'export const STALE = 1;\n', 'utf8');

    const created = approvals.create({
      project: dir,
      action: 'file.delete',
      description: `delete src/stale.ts`,
      context: { path: 'src/stale.ts', intentionId: 'test', rationale: 'cleanup' },
    });
    const decided = approvals.decide(created.id, 'approved', 'test')!;
    expect(decided.status).toBe('approved');

    const r = await fulfill(decided);
    expect(r.ok).toBe(true);
    expect(r.handled).toBe(true);
    expect(r.snapshotId).toBeDefined();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('rejected approval → 不删除文件', async () => {
    const target = path.join(dir, 'src', 'keep.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'keep\n', 'utf8');

    const created = approvals.create({
      project: dir,
      action: 'file.delete',
      description: 'delete src/keep.ts',
      context: { path: 'src/keep.ts' },
    });
    const decided = approvals.decide(created.id, 'rejected', 'test')!;
    const r = await fulfill(decided);
    expect(r.ok).toBe(true);
    expect(r.handled).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('approved 但 context.path 缺失 → 报错且不崩', async () => {
    const created = approvals.create({
      project: dir,
      action: 'file.delete',
      description: 'delete missing',
      context: {},
    });
    const decided = approvals.decide(created.id, 'approved', 'test')!;
    const r = await fulfill(decided);
    expect(r.ok).toBe(false);
    expect(r.handled).toBe(false);
    expect(r.error).toContain('path');
  });

  it('approved 删除受保护路径 → 被拒绝,文件保留', async () => {
    const target = path.join(dir, 'config', 'secrets.yaml');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'key: leak\n', 'utf8');

    const created = approvals.create({
      project: dir,
      action: 'file.delete',
      description: 'delete config/secrets.yaml',
      context: { path: 'config/secrets.yaml' },
    });
    const decided = approvals.decide(created.id, 'approved', 'test')!;
    const r = await fulfill(decided);
    expect(r.ok).toBe(false);
    expect(r.handled).toBe(true);
    expect(r.error).toContain('protected');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('未实现的 action(git.push)approved → no-op,返回 handled=false', async () => {
    const created = approvals.create({
      project: dir,
      action: 'git.push',
      description: 'push to origin',
      context: {},
    });
    const decided = approvals.decide(created.id, 'approved', 'test')!;
    const r = await fulfill(decided);
    expect(r.ok).toBe(true);
    expect(r.handled).toBe(false);
  });
});
