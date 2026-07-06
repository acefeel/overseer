import { Supervisor } from '../dist/daemon/supervisor.js';
import { loadConfig } from '../dist/util/config.js';

const cfg = loadConfig({ force: true });
const hasMainKey = !!cfg.providers[cfg.router.chain[0]]?.apiKey;

async function testStoppedModeReply() {
  // 如果没有主控 key 也没有 fallback，Supervisor 会进入 stopped 模式
  const sup = new Supervisor();
  const res = await sup.chat('查看状态');
  console.log(`  mode=${res.mode} provider=${res.provider}`);
  if (res.mode === 'stopped') {
    console.log('  ✓ stopped 模式下返回提示，不调用工具');
    return true;
  }
  // 如果有 fallback，继续后续测试
  return null;
}

async function testStatusTool() {
  const sup = new Supervisor();
  const res = await sup.chat('查看状态');
  console.log(`  mode=${res.mode} provider=${res.provider}`);
  if (res.mode === 'stopped') {
    console.log('  ⊘ skipped: stopped 模式');
    return null;
  }
  const ok = res.reply.toLowerCase().includes('mode') || res.reply.toLowerCase().includes('模式');
  console.log(ok ? '  ✓ status 工具返回包含模式信息' : `  ✗ status 回复不含模式信息: ${res.reply.slice(0, 100)}`);
  return ok;
}

async function testQueueListTool() {
  const sup = new Supervisor();
  const res = await sup.chat('列出队列');
  console.log(`  mode=${res.mode} provider=${res.provider}`);
  if (res.mode === 'stopped') {
    console.log('  ⊘ skipped: stopped 模式');
    return null;
  }
  const ok = res.reply.includes('队列') || res.reply.includes('queue') || res.reply.includes('暂无');
  console.log(ok ? '  ✓ queue.list 工具被触发' : `  ✗ 未触发 queue.list: ${res.reply.slice(0, 100)}`);
  return ok;
}

async function testPauseTool() {
  const sup = new Supervisor();
  const res = await sup.chat('暂停任务循环');
  console.log(`  mode=${res.mode} provider=${res.provider}`);
  if (res.mode === 'stopped') {
    console.log('  ⊘ skipped: stopped 模式');
    return null;
  }
  const ok = res.reply.includes('暂停') || res.reply.includes('pause');
  console.log(ok ? '  ✓ taskloop.pause 工具被触发' : `  ✗ 未触发 pause: ${res.reply.slice(0, 100)}`);
  return ok;
}

async function testConfirmation() {
  const sup = new Supervisor();
  const res = await sup.chat('清空队列');
  console.log(`  mode=${res.mode} needsConfirmation=${res.needsConfirmation}`);
  if (res.mode === 'stopped') {
    console.log('  ⊘ skipped: stopped 模式');
    return null;
  }
  if (res.mode === 'degraded') {
    // 降级模式下 queue.clear 是规则无法识别的（会被当作 queue.list），或者规则匹配失败
    console.log('  ⊘ skipped: degraded 模式不测试确认流');
    return null;
  }
  const ok = res.needsConfirmation === true && res.pendingTool?.tool === 'queue.clear';
  console.log(ok ? '  ✓ 高风险操作返回确认请求' : `  ✗ 未返回确认: ${JSON.stringify(res.pendingTool)}`);
  return ok;
}

async function main() {
  console.log(`\n=== chat-tools smoke ===`);
  console.log(`main provider key: ${hasMainKey ? 'yes' : 'no'}`);

  let pass = 0;
  let fail = 0;
  let skip = 0;

  const record = (r) => {
    if (r === true) pass++;
    else if (r === false) fail++;
    else skip++;
  };

  console.log('\n1. stopped 模式兜底');
  record(await testStoppedModeReply());

  console.log('\n2. status 工具');
  record(await testStatusTool());

  console.log('\n3. queue.list 工具');
  record(await testQueueListTool());

  console.log('\n4. taskloop.pause 工具');
  record(await testPauseTool());

  console.log('\n5. 清空队列确认流');
  record(await testConfirmation());

  console.log(`\nRESULT: ${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
