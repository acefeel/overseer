import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as approvals from '../src/supervisor/approvals.js';
import { PATHS } from '../src/util/paths.js';

const APPROVAL_FILE = path.join(PATHS.DATA_DIR, 'approvals.json');
let backup: Buffer | null = null;

describe('approvals', () => {
  beforeEach(() => {
    if (fs.existsSync(APPROVAL_FILE)) {
      backup = fs.readFileSync(APPROVAL_FILE);
    } else {
      backup = null;
    }
    fs.writeFileSync(APPROVAL_FILE, '[]', 'utf8');
  });

  afterEach(() => {
    if (backup === null) {
      if (fs.existsSync(APPROVAL_FILE)) fs.unlinkSync(APPROVAL_FILE);
    } else {
      fs.writeFileSync(APPROVAL_FILE, backup);
    }
  });

  it('create 生成 pending approval', () => {
    const a = approvals.create({
      project: 'p1',
      action: 'file.delete',
      description: '删除废弃文件',
      context: { file: 'src/old.ts' },
    });
    expect(a.status).toBe('pending');
    expect(a.id.startsWith('appr-')).toBe(true);
    expect(approvals.listPending().length).toBe(1);
  });

  it('approve 更新状态', () => {
    const a = approvals.create({
      project: 'p1',
      action: 'shell.exec',
      description: '跑迁移脚本',
      context: {},
    });
    const decided = approvals.decide(a.id, 'approved', 'test');
    expect(decided?.status).toBe('approved');
    expect(decided?.decisionBy).toBe('test');
    expect(approvals.listPending().length).toBe(0);
  });

  it('reject 更新状态', () => {
    const a = approvals.create({
      project: 'p1',
      action: 'git.push',
      description: '推送',
      context: {},
    });
    const decided = approvals.decide(a.id, 'rejected');
    expect(decided?.status).toBe('rejected');
    expect(approvals.listAll().length).toBe(1);
  });

  it('决定不存在的 id 返回 null', () => {
    expect(approvals.decide('appr-not-exist', 'approved')).toBeNull();
  });

  it('损坏文件返回空数组不崩溃', () => {
    fs.writeFileSync(APPROVAL_FILE, 'not json', 'utf8');
    expect(approvals.listAll()).toEqual([]);
    expect(approvals.listPending()).toEqual([]);
  });
});
