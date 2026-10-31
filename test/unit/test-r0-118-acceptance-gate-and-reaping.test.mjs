// R0-118：第四轮独立实测与发布验收报告（对象 = 原始 tusunsun-0.9.8.tgz，结论"公开发布 NO-GO"）
// 的**随包门禁**。这一轮报告明确说"不必大规模改动微内核"，问题全在**验收与交付体验**：
//
//   P1-01 安装验收跑手的默认命令不可用（新发现，已复现）—— 硬编码 `node_modules/npm`。
//   P1-02 没有任何 Node 版本可跑时"零通过、退出 0"（新发现，已复现）—— 门禁可以假绿。
//   P1-03 子/孙进程回收"误报成功、实际孙进程仍活着"（新发现，真实复现）—— 在 `test/lib/proc.mjs`。
//   P1-04 外部安装 + WebSocket + 浏览器 E2E 的发布门禁未闭环（环境限制）。
//
// 本文件钉 P1-01 / P1-02 / P1-04 的可机械判定面；P1-03 的行为反例在
// `test-r0-115-subprocess-leak-and-reaping.test.mjs`（W9 顽固孙进程 / W10 僵尸），此处只钉
// "判据确实写在实现里、且被导出给用例用"，避免两条战线各说各话。
//
//   G1 默认命令可用：不给 --tgz 时**真的**能定位 npm 并 pack 出制品（产物形态同样成立）
//   G2 退出码语义：一条有效验收都没跑 ⇒ 非零；--gate 模式下指定 Node 缺失 ⇒ 非零
//   G3 找不到 npm 时给出可读原因与解法（不是 MODULE_NOT_FOUND 堆栈）
//   G4 回收判据：僵尸不算活 + 整组判据 + 组内补杀 三件事都在实现里，且用例真的用了它们
//   G5 环境阻断 = NOT_RUN：策略阻断判定必须**只认策略**（连不上/DNS 不算），且门禁用它
//   G6 口径：CHANGELOG 必须把"开发树用例数"与"制品注册用例数"分开写，并写明验收退出码
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const ACCEPT = join(ROOT, 'scripts', 'install-acceptance.mjs');

/** 剥注释：结构判据必须看代码，不能被注释里的示例字样满足（R0-115 的教训）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function runAcceptance(argv, { timeoutMs = 300000 } = {}) {
  const r = spawnSync(process.execPath, [ACCEPT, ...argv], { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
  return { code: r.status, out: stripAnsi(`${r.stdout || ''}${r.stderr || ''}`), err: stripAnsi(r.stderr || '') };
}

export async function setup(runner) {
  // ── G1 默认命令必须真的可用 ─────────────────────────────────────────
  runner.test('R0-118/G1 不给 --tgz 时默认命令真的能定位 npm 并 pack 出制品（旧实现硬编码 node_modules/npm 必崩）', () => {
    const code = stripComments(read(join('scripts', 'install-acceptance.mjs')));
    // 结构反例：**主路径**不得再把开发树的 node_modules/npm 当成 npm 的唯一位置
    // （`findNpmCli` 的候选里可以有 `<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js`，
    //   那是 node 官方安装布局，与开发树无关 —— 所以这里必须锁定 `join(ROOT, 'node_modules', 'npm'…)`）。
    assert(!/join\(\s*ROOT\s*,\s*['"]node_modules['"]\s*,\s*['"]npm['"]/.test(code),
      'install-acceptance 不得再把 `join(ROOT, "node_modules", "npm", …)` 当成 npm 的唯一位置（发布包里没有它）');
    assert(/function findNpmCli/.test(code), 'install-acceptance 必须通过 findNpmCli() 探测 npm（含 PATH / Windows npm.cmd / npm_execpath 回退）');

    // 行为判据：真跑一次默认路径（--pack-only 只做到 pack，不跑旅程）
    const r = runAcceptance(['--pack-only'], { timeoutMs: 240000 });
    assertEquals(r.code, 0, `默认命令（--pack-only）必须退出 0，实际 ${r.code}：${r.out.slice(-500)}`);
    assert(/使用 npm .*（来源：/.test(r.out), `输出里应说明 npm 的来源（便于复核）：${r.out.slice(-400)}`);
    assert(/\.tgz/.test(r.out), '应报告产出的制品路径');
    assert(!/MODULE_NOT_FOUND|Cannot find module/.test(r.out), `默认命令不得以模块找不到收场：${r.out.slice(-400)}`);
    console.log(`       [实测] ${(r.out.match(/· 使用 npm .*/) || ['(未打印)'])[0]}`);
  });

  // ── G2 退出码语义：零通过 ≠ 通过 ─────────────────────────────────────
  runner.test('R0-118/G2 一条有效验收都没跑时必须非零（诊断模式退 2；门禁模式把"Node 缺失"记为失败）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r118-exit-'));
    try {
      const fake = join(dir, 'fake.tgz');           // 只需存在：所有 Node 版本都不在场 ⇒ 不进安装阶段
      writeFileSync(fake, 'not a real tarball');
      const diag = runAcceptance(['--nodes', '99', '--tgz', fake], { timeoutMs: 120000 });
      // 旧实现：通过 0 / 跳过 1 / exit 0 —— CI 可以把"什么都没跑"当绿色
      assertEquals(diag.code, 2, `全跳过时诊断模式必须退 2（实际 ${diag.code}）：${diag.out.slice(-300)}`);
      assert(/没有任何有效验收被执行/.test(diag.out), '必须明确说出"没有任何有效验收"，而不是只给个数字');

      const gate = runAcceptance(['--gate', '--nodes', '99', '--tgz', fake, '--json', join(dir, 'g.json')], { timeoutMs: 120000 });
      assertEquals(gate.code, 1, `门禁模式下指定 Node 缺失必须退 1（实际 ${gate.code}）`);
      assert(/门禁判定：.*不通过/.test(gate.out), '门禁模式必须打印判定结论');
      const json = JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8'));
      assertEquals(json.mode, 'gate', 'JSON 必须标明模式（CI 签字靠它）');
      assertEquals(json.gate.ok, false, 'JSON 的 gate.ok 必须为 false');
      assertEquals(json.gate.requested_nodes[0], '99', 'JSON 必须记录"要求的 Node 版本"');
      assertEquals(json.gate.passed, 0, 'JSON 必须记录通过数 0');
      assertEquals(json.gate.skipped, 0, '门禁模式不得有任何跳过：指定的 Node 缺失必须记成失败（否则"跳过"仍能凑出绿）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G3 找不到 npm 时的可读报错 ───────────────────────────────────────
  runner.test('R0-118/G3 找不到 npm CLI 时给出可读原因与解法（不是 MODULE_NOT_FOUND 堆栈）', () => {
    const r = runAcceptance(['--pack-only', '--npm-cli', join(tmpdir(), 'no-such-npm-xyz')], { timeoutMs: 120000 });
    assertEquals(r.code, 2, `找不到 npm 应退 2（实际 ${r.code}）`);
    assert(/找不到可用的 npm CLI/.test(r.out), `必须直说"找不到可用的 npm CLI"：${r.out.slice(-300)}`);
    assert(/--tgz|--npm-cli/.test(r.out), '必须给出解法（--npm-cli 或 --tgz）');
    assert(!/MODULE_NOT_FOUND|Cannot find module/.test(r.out), '不得把"找不到 npm"表现成模块解析失败');
  });

  // ── G4 回收判据（P1-03）——**行为**判据，不是"源码里出现某个词" ─────────
  // 第一版这里只 grep 了 `state !== 'Z'` / `liveGroupMembers` 这些字样，结果三个变异**全绿**
  //（R0-118 自查：把判据退回只看组长，字符串仍在文件里）。改成像 W9/W10 那样真起进程看结果。
  runner.test('R0-118/G4 行为判据：僵尸不算活；忽略 SIGTERM 的孙进程必须被整组 SIGKILL 带走', async () => {
    const proc = await import(pathToFileURL(join(ROOT, 'test', 'lib', 'proc.mjs')).href);
    assert(typeof proc.isProcessRunning === 'function' && typeof proc.spawnManaged === 'function',
      'proc.mjs 必须导出 isProcessRunning / spawnManaged');

    // ① 僵尸（Z）不算"在运行"——评审 P1-03 的第 1 条假阴性
    if (spawnSync('python3', ['-c', 'import sys'], { timeout: 10000 }).status === 0) {
      const z = proc.spawnManaged('python3', ['-c', [
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
      const stateOf = (pid) => {
        try {
          const st = readFileSync(`/proc/${pid}/stat`, 'utf8');
          return st.slice(st.lastIndexOf(')') + 1).trim()[0];
        } catch { return null; }
      };
      try {
        await proc.waitUntil(() => stateOf(zpid) === 'Z', { timeoutMs: 5000, what: '孙进程进入僵尸态' });
      } catch {
        throw new Error(`前置：该 pid 应进入僵尸态（实际 ${stateOf(zpid)}）`);
      }
      assertEquals(proc.isProcessRunning(zpid), false,
        '僵尸（Z）不算在运行（process.kill(pid,0) 会返回 true，这正是评审实测的假阴性）');
      const zleak = await z.reap({ graceMs: 800 });
      assertEquals(zleak.length, 0, `含僵尸的一棵树应能判为已回收：${JSON.stringify(zleak)}`);
    } else {
      runner.noteSkip('本机无 python3，僵尸场景本条不执行');
    }

    // ② 孙进程忽略 SIGTERM：必须补 SIGKILL，且**真的**死了
    const dir = mkdtempSync(join(tmpdir(), 'r118-g4-'));
    const marker = join(dir, 'stubborn.pid');
    try {
      const c = proc.spawnManaged(
        'bash',
        ['-c', `(trap '' TERM; sleep 120) & echo $! > ${JSON.stringify(marker)}; wait`],
        { stdio: 'ignore' },
      );
      await proc.waitUntil(() => existsSync(marker), { timeoutMs: 15000, what: '顽固孙进程 pid 落盘' });
      const grand = Number(readFileSync(marker, 'utf8').trim());
      assert(proc.isProcessRunning(grand), `前置：孙进程应先活着（pid=${grand}）`);
      const detail = await c.reapDetail({ graceMs: 600 });
      assertEquals(detail.ok, true, `整组必须真的收干净：${JSON.stringify(detail)}`);
      assertEquals(detail.how, 'SIGKILL', `必须升级到 SIGKILL（实际 ${detail.how}；退回"组长退了就算成功"会得 SIGTERM）`);
      assertEquals((detail.survivors || []).length, 0, `不得有幸存者：${JSON.stringify(detail.survivors)}`);
      await new Promise((r) => setTimeout(r, 300));
      assert(!proc.isProcessRunning(grand), `孙进程必须真的死了（pid=${grand}）`);
      console.log(`       [实测] 僵尸判活=false；顽固孙进程 pid=${grand} 经 ${detail.how} 清除`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── G5 环境阻断只能记 NOT_RUN，且只认"策略"这一类 ────────────────────
  runner.test('R0-118/G5 导航被环境策略阻断 ⇒ NOT_RUN；连不上/DNS/证书不得冒充"环境问题"', async () => {
    const cdpPath = join(ROOT, 'test', 'lib', 'cdp.mjs');
    const cdp = await import(pathToFileURL(cdpPath).href);
    assertEquals(typeof cdp.isNavigationBlockedByPolicy, 'function', 'cdp.mjs 必须导出 isNavigationBlockedByPolicy');
    // 真函数真跑：策略类 → true；其它错误 → false（否则"环境"会变成万能免检理由）
    const blocked = ['net::ERR_BLOCKED_BY_ADMINISTRATOR', 'net::ERR_ACCESS_DENIED', 'net::ERR_BLOCKED_BY_CLIENT'];
    for (const code of blocked) {
      assertEquals(cdp.isNavigationBlockedByPolicy(Object.assign(new Error('x'), { errorText: code })), true,
        `${code} 属于环境策略阻断，应判 true`);
    }
    const notBlocked = ['net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CERT_AUTHORITY_INVALID', '', 'net::ERR_ABORTED'];
    for (const code of notBlocked) {
      assertEquals(cdp.isNavigationBlockedByPolicy(Object.assign(new Error('x'), { errorText: code })), false,
        `"${code}" 不是环境策略阻断，不得判 true（否则真实故障会被记成 NOT_RUN）`);
    }

    // 门禁侧：浏览器用例必须有 guard，且 guard 用的是这个判据
    const b = read(join('test', 'integration', 'chat-ui-browser-security.test.mjs'));
    assert(/isNavigationBlockedByPolicy/.test(b), '浏览器门禁必须用 isNavigationBlockedByPolicy 区分环境阻断与真故障');
    assert(/ctx\.blocked/.test(b) && /noteSkip/.test(b), '被阻断时必须走 noteSkip（NOT_RUN），不得记 PASS');
    assert(/const test = \(name, fn\) => runner\.test\(name, async/.test(b),
      '必须定义 guard 包装器（否则单条用例会以"等待超时"的面貌假失败）');
    const guarded = [...b.matchAll(/^  test\('R0-116\/B\d/gm)].length;
    assertEquals(guarded, 7, `7 条页面级用例都必须经 guard 注册（实际 ${guarded} 条；有 1 条漏掉就等于它不认"环境阻断"）`);
  });

  // ── G6 口径：两种检出形态的数字必须分开写 ───────────────────────────
  runner.test('R0-118/G6 CHANGELOG 必须把"开发树用例数"与"制品注册用例数"分列，并写明验收退出码语义', () => {
    const log = read('CHANGELOG.md');
    const head = log.slice(0, log.indexOf('\n## ', 10) > 0 ? log.indexOf('\n## ', 10) : log.length);
    assert(/开发树|开发检出/.test(head) && /制品|发布包|npm 包/.test(head),
      '当前版本的 CHANGELOG 必须同时出现"开发树"与"制品"两种形态（第四轮评审点名 419 与 1133 被混用）');
    assert(/退出码/.test(head) && /通过数为 0/.test(head) && /找不到 npm/.test(head),
      '必须写明验收跑出的三档语义（0 / 1 / 2，其中 2 = 通过数为 0 或找不到 npm），不能只提一句"退出码"');
    assert(/NOT_RUN|不计通过|不折算/.test(head), '必须写明跳过不折算为通过');
  });

  // ── G7 TUI 真跑：键位真的可用，且开鉴权的网关上连得上 ─────────────────
  // 第四轮报告说"交互式 TUI 至少做一次人工实际键盘操作"。照做时抓到**两个真缺陷**：
  //   ① `WsClient` 握手不带口令 ⇒ 网关一配 apiKey（常规形态），`tusunsun tui` 直接
  //      "socket hang up"，面板根本起不来；
  //   ② `_handleKey()` 对普通字符走的是 `(null, ch)`，而命令判定在比 `key === 'q'/'1'…` ⇒
  //      **键盘上一个键都不生效**（按 q 退不出去）。面板能画，但没有一处能操作。
  // 这条门禁用 pty（`script -qec`）真的按一次 q，要求它退出、且全程没有连接失败。
  runner.test('R0-118/G7 TUI 经 pty 真按键：开鉴权网关连得上、按 q 真的退出', async () => {
    if (process.platform !== 'linux') { runner.noteSkip('非 Linux，pty 驱动方式不适用'); return; }
    if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0) {
      runner.noteSkip('本机没有 `script`（util-linux），无法分配 pty');
      return;
    }
    const proc = await import(pathToFileURL(join(ROOT, 'test', 'lib', 'proc.mjs')).href);
    const key = 'tui-gate-key';
    const dir = mkdtempSync(join(tmpdir(), 'r118-tui-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      activeScene: 'gateway',
      gateway: { host: '127.0.0.1', port: 0, apiKey: key },
    }, null, 2));
    const gw = proc.spawnManaged(process.execPath,
      [join(ROOT, 'tusunsun.mjs'), 'start', '--port', '0', '--state-dir', dir, '--yes'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], label: 'r118-gateway',
        env: { ...process.env, TUSUNSUN_STATE_DIR: '' } });
    const keep = dir;
    let port = 0;
    try {
      await proc.waitUntil(() => {
        try {
          const rt = JSON.parse(readFileSync(join(keep, 'gateway.runtime.json'), 'utf8'));
          if (typeof rt.port === 'number' && rt.port > 0) { port = rt.port; return true; }
        } catch { /* 还没落盘 */ }
        return false;
      }, { timeoutMs: 40000, what: '网关端口落盘' });

      const t0 = Date.now();
      const r = spawnSync('bash', ['-c',
        `( sleep 6; printf 'q' ) | timeout 45 script -qec "node tusunsun.mjs tui --port ${port}" /dev/null`,
      ], { cwd: ROOT, encoding: 'utf8', timeout: 90000, env: { ...process.env, TUSUNSUN_STATE_DIR: keep } });
      const out = stripAnsi(`${r.stdout || ''}${r.stderr || ''}`);
      const elapsed = Date.now() - t0;
      console.log(`       [实测] TUI 退出码=${r.status}、耗时 ${Math.round(elapsed / 1000)}s、输出 ${out.length}B`);

      assertEquals(/无法连接 daemon/.test(out), false,
        `TUI 连不上开鉴权的网关（正是修复前的症状）：${out.slice(-300)}`);
      assert(/TUI/.test(out), `面板没有渲染：${out.slice(0, 300)}`);
      assert(/running/.test(out), '面板没有渲染出运行状态（证明它真的连上了网关）');
      assertEquals(r.status, 0, `按 q 必须退出 0（实测 ${r.status}；修复前单键命令全部失效，会挂到超时）`);
      assert(elapsed < 30000, `按 q 后应立刻退出，实测 ${Math.round(elapsed / 1000)}s`);
    } finally {
      try { await gw.reap({ graceMs: 2000 }); } catch { /* 已退出 */ }
      rmSync(keep, { recursive: true, force: true });
    }
  });
}

export default setup;
