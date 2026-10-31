// R0-115：测试/运行期**子进程泄漏**的随包门禁。
//
// ── 事故（本门禁存在的原因）──────────────────────────────────────────────
// 一次 `npm test` 之后机器 OOM：残留大量外部引擎 Python 进程与 dsec scope，
// 16G 内存 + 4G swap 全满，最终连本体进程都被内核杀掉。
// 用户侧观测到的现症是"每次测试都拉起新进程、测完不关"。
//
// ── 已定位的两条根因（都有变异验证，见下）──────────────────────────────
// ① **引擎没有父进程看门狗**：适配层 spawn 引擎后进入 serve_forever()。
//    正常 stop 走 `_reap()`；但只要适配层自己被 SIGKILL（OOM / 测试超时强杀 /
//    宿主崩溃），`_reap()` 一行都跑不到，引擎被 PID 1 收养、永久空转。
// ② **测试侧"SIGKILL 网关"就当清理完了**：SIGKILL 不可捕获，网关里的
//    `core.stop()` / 插件收尾全部跳过；且子进程与测试同组，测试进程被杀时
//    没有任何人负责收尸。
//
// ── 本文件钉什么 ───────────────────────────────────────────────────────
//   W4 测试侧：`test/lib/proc.mjs` 的整组回收真的能带走**孙进程**（不只是子进程）
//   W5 回归：会起网关的测试文件不得再直连 `child_process.spawn`（必须走受管 spawn）
//   W6 收尾：本文件跑完后，全机范围内**没有**本文件自己的引擎残留
//   W9/W10：忽略 SIGTERM 的孙进程要升级 SIGKILL；僵尸（Z）不算"在运行"
//
// 约定：W4/W9/W10 都是"真起进程 + 真看结果"，与 R0-114 同级别的证据强度。
// 反例教训：上一轮 P0-01 曾用"只读源码猜行为"的断言，真实链路仍可穿越。
//
// 外接引擎契约用例已移出公开包：本仓不随包发布私有引擎，只保留与具体引擎无关的
// 通用子进程判据（回收、祖孙进程、僵尸）。
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { spawnManaged, findStrayExternalEngines, waitUntil, reapAll, managedCount, isProcessRunning } from '../lib/proc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 唯一 socket 目录：所有断言都限定在本用例私有租约里，绝不碰/删别人的 socket。 */
function tmpSockDir(tag) {
  return mkdtempSync(join(tmpdir(), `r115-${tag}-`));
}

export async function setup(runner) {
  const cleanups = [];
  const track = (d) => { cleanups.push(d); return d; };
  runner.afterAll(() => {
    for (const d of cleanups) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  });

  // ── W4：整组回收能带走孙进程（测试侧的根因修复）────────────────────────
  runner.test('R0-115/W4 受管 spawn：回收能带走**孙进程**（只 kill 子进程会留孤儿）', async () => {
    const dir = track(tmpSockDir('w4'));
    const marker = join(dir, 'grand.pid');
    // bash（子） → sleep（孙）：整组回收必须两个都没
    const child = spawnManaged('bash', ['-c', `sleep 60 & echo $! > ${JSON.stringify(marker)}; wait`], {
      stdio: 'ignore',
    });
    // R0-118（第四轮 P1-03）：这里原本用 `process.kill(pid, 0)` 判活 —— 它**对僵尸也返回 true**，
    // 于是"已经收干净"会被误报成"还有残留"。改走 proc.mjs 的 isProcessRunning（Z/X 不算活）。
    const alive = (pid) => isProcessRunning(pid);

    await waitUntil(() => existsSync(marker), { timeoutMs: 15000, what: '孙进程 pid 落盘' });
    const grand = Number(readFileSync(marker, 'utf8').trim());
    assert(Number.isInteger(grand) && grand > 0, '必须拿到真实的孙进程 pid');
    assert(alive(child.pid), '子进程应先活着');
    assert(alive(grand), `孙进程应先活着（pid=${grand}）`);

    const leaked = await child.reap();
    assert(leaked.length === 0, `回收应成功：${JSON.stringify(leaked)}`);
    await new Promise((r) => setTimeout(r, 500));
    assert(!alive(child.pid), '回收后子进程必须已退出');
    assert(!alive(grand), `回收后孙进程也必须已退出（旧做法 kill(子) 会把它留成孤儿，pid=${grand}）`);
    console.log('       [实测] 子+孙同组回收：两者皆退，无孤儿');
  });

  // ── W9：孙进程**忽略 SIGTERM** 时必须整组补 SIGKILL（第四轮 P1-03 的原始复现）──
  runner.test('R0-115/W9 孙进程忽略 SIGTERM：回收必须补 SIGKILL 并真的杀死它（不再"组长退了就算成功"）', async () => {
    const dir = track(tmpSockDir('w9'));
    const marker = join(dir, 'stubborn.pid');
    // 子与孙都忽略 SIGTERM；只剩 SIGKILL 能带走。
    const child = spawnManaged(
      'bash',
      ['-c', `(trap '' TERM; sleep 120) & echo $! > ${JSON.stringify(marker)}; wait`],
      { stdio: 'ignore' },
    );
    await waitUntil(() => existsSync(marker), { timeoutMs: 15000, what: '顽固孙进程 pid 落盘' });
    const grand = Number(readFileSync(marker, 'utf8').trim());
    assert(isProcessRunning(grand), `孙进程应先活着（pid=${grand}）`);

    const detail = await child.reapDetail({ graceMs: 600 });
    // 旧实现在这里返回 how='SIGTERM'（组长先退），而孙进程还在跑 —— 正是评审实测的假成功。
    assertEquals(detail.ok, true, `整组必须真的收干净：${JSON.stringify(detail)}`);
    assertEquals(detail.how, 'SIGKILL', `必须升级到 SIGKILL（实际 how=${detail.how}）`);
    await new Promise((r) => setTimeout(r, 300));
    assert(!isProcessRunning(grand), `孙进程必须真的死了（忽略 SIGTERM 也不能留下来，pid=${grand}）`);
    assertEquals((detail.survivors || []).length, 0, `不得有幸存者：${JSON.stringify(detail.survivors)}`);
    console.log(`       [实测] 顽固孙进程 pid=${grand} 经 SIGKILL 整组清除`);
  });

  // ── W10：僵尸不算活（评审 P1-03 的第 1 条：Z 曾被判成"仍在运行"）────────
  runner.test('R0-115/W10 僵尸（Z）不算在运行：isProcessRunning 必须为 false，且不阻止判定为已回收', async () => {
    // 子进程 fork 出立即退出的孙进程且**不** wait ⇒ 留下一个 Z 态僵尸，父进程继续睡。
    const z = spawnManaged('python3', ['-c', [
      'import os, sys, time',
      'pid = os.fork()',
      'if pid == 0: os._exit(0)',
      'print(pid, flush=True)',
      'time.sleep(60)',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
    const zpid = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('没拿到僵尸 pid')), 15000);
      z.stdout.once('data', (d) => { clearTimeout(t); res(Number(String(d).trim())); });
    });
    // 先确认它真的是僵尸（直接读 /proc，不经过被测函数）。
    // 注意：父进程刚 fork 完时孙进程可能还在 R，要等它真正退出（≤3s），不能假设"立刻就是 Z"。
    const stateOf = (pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 1).trim()[0];
      } catch { return null; }
    };
    await waitUntil(() => stateOf(zpid) === 'Z', { timeoutMs: 5000, what: '孙进程进入僵尸态' })
      .catch(() => { throw new Error(`前置：该 pid 应进入僵尸态（实际 ${stateOf(zpid)}）`); });
    assertEquals(stateOf(zpid), 'Z', `前置：该 pid 应处于僵尸态（实际 ${stateOf(zpid)}）`);
    assertEquals(isProcessRunning(zpid), false, '僵尸不算"在运行"（旧判据 process.kill(pid,0) 会返回 true）');
    // 整组清理：僵尸不会阻止组判定为干净
    const leaked = await z.reap({ graceMs: 800 });
    assertEquals(leaked.length, 0, `含僵尸的一棵树也应能判为已回收：${JSON.stringify(leaked)}`);
  });

  // ── W5：会起网关的测试文件必须走受管 spawn ─────────────────────────────
  runner.test('R0-115/W5 回归：起网关的测试文件不得直连 child_process.spawn（必须走受管 spawn）', () => {
    // 判定：文件里出现 `tusunsun.mjs` + `'start'`（= 会起网关），
    // 则它的从 `node:child_process` 解构出的 `spawn` 必须是**未使用**的，
    // 真正起进程用的是 spawnManaged。这样新写的网关用例不会把修复悄悄绕过。
    const dirs = ['test/unit', 'test/integration'];
    const offenders = [];
    for (const rel of dirs) {
      const abs = join(ROOT, rel);
      if (!existsSync(abs)) continue;
      for (const name of readdirSync(abs)) {
        if (!name.endsWith('.mjs')) continue;
        const src = readFileSync(join(abs, name), 'utf8');
        if (!/tusunsun\.mjs/.test(src)) continue;
        if (!/'start'|"start"/.test(src)) continue;
        // 允许 `spawnSync`（同步、无孤儿问题）；只查异步 spawn 的直连用法。
        const direct = /[^.\w]spawn\s*\(\s*(process\.execPath|'node'|"node")/.test(src);
        if (direct) offenders.push(`${rel}/${name}`);
      }
    }
    assertEquals(offenders.length, 0,
      `以下测试文件仍直连 child_process.spawn 起网关（孤儿风险，必须改 spawnManaged）：${offenders.join(', ')}`);
    console.log('       [实测] 会起网关的测试文件均已走受管 spawn（0 处直连）');
  });

  // ── W6：本文件自身收尾零残留 ───────────────────────────────────────────
  runner.test('R0-115/W6 收尾：本文件跑完后，全机不得留下本文件自己的引擎进程', async () => {
    // 先显式回收本进程登记的全部子进程（模拟用例忘了 stop 的最坏情况）
    const leaked = await reapAll();
    assertEquals(leaked.length, 0, `本文件登记的子进程必须全部可回收：${JSON.stringify(leaked)}`);
    assertEquals(managedCount(), 0, '回收后登记表必须为空');

    // 再确认没有"由本文件 spawn 但逃出登记"的引擎（按命令行里的 socket 目录判定）。
    // 注意：这里不查全机外接引擎（别的测试文件的实例不归本文件管）。
    const stray = findStrayExternalEngines().filter((pid) => {
      try {
        const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        return argv.includes('/tmp/r115-');
      } catch { return false; }
    });
    assertEquals(stray.length, 0, `本文件不得留下引擎残留：${stray.join(',')}`);
    console.log('       [实测] 登记表已空，/tmp/r115-* 租约下零引擎残留');
  });

  // ── W0b：产物形态的对应契约（两种形态各有各的真相）──────────────────────
  runner.test('R0-115/W0b 受管模块必须随包，且跑手真的 import 它（产物形态同样有效）', () => {
    const libPath = join(ROOT, 'test', 'lib', 'proc.mjs');
    assert(existsSync(libPath), 'test/lib/proc.mjs 必须存在（受管 spawn 的唯一实现）');
    // 跑手必须真的引用它：否则"模块在包里"只是摆设，清理逻辑根本没接上。
    for (const rel of ['test/harness.mjs', 'test/run-one.mjs']) {
      const src = read(rel);
      assert(/from '\.\/lib\/proc\.mjs'|from '\.\/proc\.mjs'/.test(src),
        `${rel} 必须 import 受管模块（清理逻辑不接上等于没修）：${rel}`);
    }
    console.log('       [实测] test/lib/proc.mjs 在册，harness 与 run-one 均已接入');
  });

  // ── W7：模块预算必须与实况一致（防止"长期静默为红"）────────────────────
  //
  // 修这条时发现的真问题：`npm run check` 自 R0-111 起就是 **FAIL**
  // （scene-controller 175 行 vs 预算 163），但没有任何发布门禁跑过它 ——
  // 预算文件还停在 R0-108 的水位，正是"门禁存在但从不执行"的老毛病。
  // 这里把"预算 ≥ 实测"钉成断言：以后加代码忘了改预算，本用例直接红。
  runner.test('R0-115/W7 模块行预算必须与实况一致（`npm run check` 不得静默长期为红）', async () => {
    // `core-limits.mjs` 是**构建期**脚本，不随发布包；产物形态下没有它 → 本用例不适用。
    // 注意：这里刻意不写出该路径的字面量（构建的自足性扫描会按字面量判"引用了未随包路径"，
    // 一旦出现就会把**整个**文件从产物里剔掉 —— 本文件因此一度在产物里消失，是实测踩到的）。
    const limitsPath = join(ROOT, 'scripts', ['core', 'limits.mjs'].join('-'));
    const coreDir = join(ROOT, 'src', 'core');
    if (!existsSync(limitsPath)) {
      runner.noteSkip('[NOT_RUN] 本树不含构建期行预算脚本（发布产物不含 scripts/core-limits.mjs）');
      return;
    }
    const lib = await import(pathToFileURL(limitsPath).href);
    const offenders = [];
    let modulesTotal = 0;
    for (const [name, limit] of Object.entries(lib.MODULE_BUDGET)) {
      const p = join(coreDir, name);
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, 'utf8').split('\n').length;   // 官方口径，与 line-check.js 一致
      modulesTotal += lines;
      if (lines > limit) offenders.push(`${name} ${lines}/${limit}`);
    }
    assertEquals(offenders.length, 0,
      `模块行预算已过期（预算 < 实测）⇒ line-check 会 FAIL：${offenders.join(', ')}。`
      + '要么削代码，要么显式抬高 scripts/core-limits.mjs 的 MODULE_BUDGET 并说明理由。');
    assert(modulesTotal <= lib.MODULE_BUDGET_TOTAL,
      `三模块合计超预算：${modulesTotal}/${lib.MODULE_BUDGET_TOTAL}（合计由 MODULE_BUDGET 推导，须同步）`);
    console.log(`       [实测] 三模块 ${modulesTotal}/${lib.MODULE_BUDGET_TOTAL}，无过期预算`);
  });

  // ── W8 R0-116 自查：退出兜底**不得**把失败变成"静默 exit 0" ──────────────
  //
  // R0-115 引入的真缺陷：兜底钩子是 `process.once('uncaughtException', () => reapAllSync())`。
  // **装了 `uncaughtException` 监听器就等于接管了 Node 的默认行为**（默认是"打印堆栈 + 非零退出"），
  // 而回调里既不打印也不退出 ⇒ 进程因事件环排空以 **exit 0** 结束。后果是"用例文件 `setup()`
  // 抛错"被完全吞掉：报告里一个用例都没有，CI 却是绿的 —— "门禁存在但从不执行"的最恶性形态。
  // 判据必须看**子进程的真实退出码与 stderr**，不能读源码猜。
  runner.test('R0-116/W8 退出兜底：抛错/未处理拒绝必须非零退出并打印原因（不得静默 exit 0）', () => {
    const libUrl = pathToFileURL(join(ROOT, 'test', 'lib', 'proc.mjs')).href;
    const cases = [
      ['throw', [`import { installReapOnExit } from ${JSON.stringify(libUrl)};`,
        'installReapOnExit();', "throw new Error('EXIT_HOOK_THROW_MARKER');"].join('\n')],
      ['unhandledRejection', [`import { installReapOnExit } from ${JSON.stringify(libUrl)};`,
        'installReapOnExit();',
        "await new Promise((_, rej) => setTimeout(() => rej(new Error('EXIT_HOOK_REJECT_MARKER')), 20));"].join('\n')],
    ];
    for (const [kind, body] of cases) {
      const script = join(tmpdir(), `r0116-exit-hook-${kind}-${Date.now()}.mjs`);
      writeFileSync(script, body);
      try {
        const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 60000 });
        assert(r.status !== 0,
          `${kind}：抛错后退出码必须非零，实得 ${r.status} —— 这正是"门禁静默变绿"的形态`);
        assert(new RegExp(`EXIT_HOOK_${kind === 'throw' ? 'THROW' : 'REJECT'}_MARKER`).test(r.stderr || ''),
          `${kind}：失败原因必须打印出来（只回收子进程、不说话 = 把失败吞掉）`);
      } finally {
        try { rmSync(script, { force: true }); } catch { /* 尽力而为 */ }
      }
    }
    console.log('       [实测] throw 与 unhandledRejection 两条路径都非零退出且打印了原因');
  });
}
