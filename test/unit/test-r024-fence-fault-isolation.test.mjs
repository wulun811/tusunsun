// R0-024（rc.15）：事实与观察的隔离（专家 rc.14 复审 M2）。
//
// M2 一句话：**围栏的 `postCheck` 是观察，不是事实源。**
//
// 工具跑完那一刻，"跑过没有、结果是什么"已经是过去的事实。`postCheck` 在那之后才被调用，
// 它干两件事：记熔断（观察）与脱敏（改写输出）。这两件事都**不构成**"跑成没跑成"。
// 修前两处调用点都是裸 `await`：
//
//   成功路径 —— 围栏抛错 ⇒ 异常穿出 `_finishExecuteSuccess`，落进 `_executeOneInner` 的
//               catch ⇒ `_finishExecuteError` ⇒ **已经写进磁盘的写被报成 failed**。
//               副作用发生了，回执却说没发生；调用方据此重试就是重复写。
//   错误路径 —— 围栏抛错 ⇒ 原始错误（超时 / `dispatched:true` / `execution_outcome:unknown`）
//               被整个顶掉，连 `tool.result` 事件都发不出去：审计既丢了"到底怎么失败的"，
//               也丢了"围栏出过事"。
//
// 修法必须**双向**：不掩事实（上面两条），也不掩围栏故障（异常证据要留在结果与审计里）。
// 于是每条安全判据都配一条反向判据，证明修的不是"把围栏关掉"：
//   /4 正常围栏仍然改写输出（脱敏照旧生效）
//   /5 围栏返回非字符串视为"不改写"（一次笔误不得抹掉工具的全部产出）
//   /6 `preCheck` 抛错仍然**拒绝执行**：方向相反，不许一起吞掉
//
// 判据尽量对着**磁盘**判而不是对着返回体自洽性判 —— "已执行"这件事的证据在文件里，
// 不在执行器自己说的话里。
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const T = (await imp('plugins/tool-executor.js')).default;
  const mod = await imp('plugins/tool-executor.js');   // setFence / removeFence：模块级登记表

  /**
   * 造一个真 Core + 真执行器 + 一条**真的会写盘**的能力。
   *
   * 为什么能力里要真写文件：本文件的问题是"已发生的写被报成没发生"，
   * 只有对着磁盘判，"发生了"才有独立于返回体的证据。
   */
  async function makeHost(t, opts = {}) {
    const d = mkdtempSync(join(tmpdir(), 'r024-'));
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    // 配置是**服务**不是字段（`core.get` 转给 `config` 服务），所以这里注册一个只回答
    // 「权限档位」的桩 —— 不给它就落到 `auto`，而 `auto` 与 `full-auto` 在 preCheck 上
    // 走的是两条路（`full-auto` 根本不调前置围栏），这正是 /6 要测的那条。
    core.registerService('config', { get: (p, dflt) => (p === 'tools.permissionMode' ? (opts.mode || 'auto') : dflt) });
    core.setData('agent.workDir', d);

    const inst = Object.create(T);
    inst._preHooks = []; inst._postHooks = []; inst._dispatchHooks = [];
    inst._rateCalls = new Map(); inst._cache = new Map(); inst._auditLog = new Map();
    inst._receipts = new Map(); inst._receiptMax = 100;
    inst._metrics = new Map(); inst._preferences = new Map(); inst._debugStream = null;
    await inst.init(core);
    return { d, core, exec: inst, target: join(d, 'm2-target.txt') };
  }

  /**
   * 装一份**只对这个 core 生效**的围栏，并在用例结束时摘掉。
   * 作用域必须收窄：`_fences` 是模块级登记表，泄漏出去会让别的测试文件测到的不是它自己配的东西。
   */
  async function withFence(host, fence, fn) {
    const { token } = mod.setFence(fence, { owner: 'r024-m2', core: host.core });
    try {
      return await fn();
    } finally {
      mod.removeFence({ token });
    }
  }

  /** 收集一次执行发出的围栏事件（审计的实时面）。 */
  function collect(host, event) {
    const seen = [];
    host.core.on(event, (p) => seen.push(p));
    return seen;
  }

  // ══ M2 主干：成功路径上围栏抛错，事实不得被改写 ═════════════════════
  runner.test('R0-024/1 围栏 postCheck 抛错时，已经写进磁盘的写不得被报成失败', async () => {
    const h = await makeHost();
    try {
      h.core.registerCapability('tool.m2write', {
        owner: 'm2write',
        handler: async () => {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(h.target, 'PAYLOAD');
          return `Written 7 bytes to ${h.target}`;
        },
      });
      const r = await withFence(h, {
        preCheck: () => ({ ok: true }),
        postCheck: () => { throw new Error('fence down'); },
      }, () => h.exec.executeOne('tool-m2write', { path: 'm2-target.txt' }, 's1', 'c1'));

      // ① 事实面：写真的落盘了。这条是独立证据 —— 它不依赖执行器怎么自述。
      assert(existsSync(h.target), '前提：handler 必须真的写过盘（否则本用例测的是另一件事）');
      assertEquals(readFileSync(h.target, 'utf8'), 'PAYLOAD', '磁盘内容必须是 handler 写下的那份');
      // ② 结论面：修前这里是 ok:false / state:'failed'（异常被 catch 成执行失败）
      assertEquals(r.ok, true, `已执行的写不得因围栏故障被报成失败，实际 ok=${r.ok} state=${r.state} err=${r.error}`);
      assertEquals(r.state, 'succeeded', 'state 必须仍是 succeeded —— 围栏故障不是执行结果的一部分');
      assert(String(r.result).startsWith('Written 7 bytes'), `工具输出必须原样返回（围栏没给出改写），实际 "${r.result}"`);
      console.log(`       [实测] 落盘=${existsSync(h.target)} ok=${r.ok} state=${r.state}`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ M2 另一半：故障必须留证据，不能被"悄悄修好" ═════════════════════
  runner.test('R0-024/2 围栏故障必须留下异常证据（结果 + 审计 + 事件三处一致）', async () => {
    const h = await makeHost();
    try {
      h.core.registerCapability('tool.m2write', { owner: 'm2write', handler: async () => 'PLAIN' });
      const events = collect(h, 'tool.fence_error');
      const r = await withFence(h, {
        preCheck: () => ({ ok: true }),
        postCheck: () => { throw new Error('breaker exploded'); },
      }, () => h.exec.executeOne('tool-m2write', {}, 's2', 'c2'));

      // 只吞不记等于"围栏一直在坏，而所有人以为它是好的" —— 那是另一种假绿。
      assert(r.fence_error && typeof r.fence_error === 'object',
        `结果必须携带 fence_error（否则调用方与运维都看不到围栏坏过），实际 ${JSON.stringify(r.fence_error)}`);
      assertEquals(r.fence_error.stage, 'post', '必须标明是后置围栏（前置围栏故障的方向是拒绝，不能混）');
      assert(/breaker exploded/.test(r.fence_error.message || ''),
        `fence_error.message 必须带原始故障文本，实际 "${r.fence_error.message}"`);

      const audit = h.exec.getAuditLog('s2');
      const last = audit[audit.length - 1];
      assert(last?.fence_error, `审计条目必须留异常证据（M2 原文），实际 ${JSON.stringify(last)}`);
      assertEquals(last.status, 'success', '审计的 status 仍是本次执行的真实结局，不因围栏故障改写');

      assertEquals(events.length, 1, `必须发一条 tool.fence_error 事件，实际 ${events.length} 条`);
      assert(/breaker exploded/.test(events[0].message || ''), '事件的 message 必须与被吞的异常一致');
      assertEquals(events[0].success, true, '事件要说明当时判定的是成功还是失败（同一个故障，两种含义不同）');
      console.log(`       [实测] fence_error=${JSON.stringify(r.fence_error)} 事件=${events.length} 条`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ M2 错误路径：不得遮蔽原始错误 ═══════════════════════════════════
  runner.test('R0-024/3 工具失败时围栏再抛错，不得顶掉错误码与“效果未知”的结论', async () => {
    const h = await makeHost();
    try {
      // 名字借用两个**已声明为 execution_result** 的主体（`EXECUTION_RESULT_SUBJECTS`）：
      // 未声明主体的 `{ok:false}` 按设计就是不透明业务数据，根本进不到失败路径，
      // 在这里用假名字只会测到“被判成功”这件无关的事。
      // 具名失败码 + 已派发：额度里“最不能丢”的那句话 —— 丢了它上层会以为“确定没写”。
      h.core.registerCapability('tool.validate', {
        owner: 'm2fail',
        handler: async () => {
          throw Object.assign(new Error('disk full'), { code: 'EIO_M2', dispatched: true });
        },
      });
      // `timeout` 是 Core 信封里唯一能完整穿过 `_toolFailure` 的“效果未知”码；
      // 它和上面那条合起来，覆盖“错误码被顶掉”与“不确定结论被降级”两种丢法。
      h.core.registerCapability('tool.grep', {
        owner: 'm2hang',
        handler: async () => {
          throw Object.assign(new Error('no answer'), { code: 'timeout', dispatched: true });
        },
      });
      const fence = { preCheck: () => ({ ok: true }), postCheck: () => { throw new Error('fence down on error path'); } };

      const a = await withFence(h, fence, () => h.exec.executeOne('tool-validate', {}, 's3', 'c3'));
      assertEquals(a.ok, false, '工具失败仍是失败（围栏故障不得把它"修"成成功）');
      assertEquals(a.code, 'EIO_M2', `原始错误码必须透传，实际 ${a.code}（修前整个被围栏异常顶掉，连 r 都不会存在）`);
      assert(/disk full/.test(a.error || ''), `原始错误文本必须保留，实际 "${a.error}"`);
      // 审计是**独立于返回体**的那条线：修前围栏一抛错，连 `tool.result` 都发不出去、
      // `_addAudit` 一次都不跑（实测 0 条）——“审计仍有异常证据”说的就是这里。
      // 注：`dispatched` 目前在这条路上是**缺失**的（Core 只在 denied 降级时才填），
      // 那属于 M6 的“证据有限字段合同”，本用例不替它下结论。
      const audit = h.exec.getAuditLog('s3');
      const last = audit[audit.length - 1];
      assertEquals(last?.status, 'error', `错误路径必须留下审计条目，实际 ${JSON.stringify(last)}`);
      assertEquals(last?.fence_error?.stage, 'post', '审计条目里同样要有围栏故障证据');
      assert(a.fence_error && /fence down on error path/.test(a.fence_error.message || ''),
        '错误路径的围栏故障同样要留证据（两处调用点，不许只修一处）');

      const b = await withFence(h, fence, () => h.exec.executeOne('tool-grep', {}, 's3b', 'c3b'));
      assertEquals(b.ok, false, '超时仍然是非成功');
      assertEquals(b.result_kind, 'indeterminate',
        `“效果未知”不得被围栏故障降级，实际 ${b.result_kind}（降级成 failed 就等于说“确定没写”是错的）`);
      assert(b.fence_error, '第二条路径同样要留围栏故障证据');
      console.log(`       [实测] a.code=${a.code} 审计=${audit.length} 条 b.result_kind=${b.result_kind} 两处 fence_error 均在`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ 反向判据 1：围栏正常时仍然改写输出 ═════════════════════════════
  runner.test('R0-024/4 反向判据：正常围栏仍然能改写输出（脱敏不得因噎废食）', async () => {
    const h = await makeHost();
    try {
      h.core.registerCapability('tool.m2secret', { owner: 'm2secret', handler: async () => 'token=SECRET123 ok' });
      const r = await withFence(h, {
        preCheck: () => ({ ok: true }),
        postCheck: (tool, output) => String(output).replace(/SECRET\d+/, '[REDACTED]'),
      }, () => h.exec.executeOne('tool-m2secret', {}, 's4', 'c4'));

      assertEquals(r.result, 'token=[REDACTED] ok', `围栏的改写必须生效，实际 "${r.result}"`);
      assertEquals(r.fence_error, undefined, '正常围栏不得被记成故障（否则 fence_error 就成了噪音）');
      console.log(`       [实测] 输出被改写成 "${r.result}"`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ 反向判据 2：围栏返回非字符串 = 不改写，不是"抹掉输出" ═══════════
  runner.test('R0-024/5 围栏返回 undefined 时不得抹掉工具输出（返回"没有新值"≠"输出为空"）', async () => {
    const h = await makeHost();
    try {
      h.core.registerCapability('tool.m2void', { owner: 'm2void', handler: async () => 'IMPORTANT OUTPUT' });
      const r = await withFence(h, {
        preCheck: () => ({ ok: true }),
        postCheck: () => undefined,
      }, () => h.exec.executeOne('tool-m2void', {}, 's5', 'c5'));

      assertEquals(r.result, 'IMPORTANT OUTPUT',
        `围栏返回非字符串必须按"不改写"处理，实际 "${r.result}" —— 一次笔误不该让模型看不见工具干了什么`);
      console.log(`       [实测] 输出原样保留："${r.result}"`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ 反向判据 3：前置围栏故障仍然拒绝执行（方向相反，不许一起吞） ═══
  runner.test('R0-024/6 反向判据：preCheck 抛错仍然拒绝执行，工具一次都不许跑', async () => {
    const h = await makeHost();
    try {
      let ran = 0;
      h.core.registerCapability('tool.m2pre', {
        owner: 'm2pre',
        handler: async () => { ran++; return 'SHOULD NOT RUN'; },
      });
      const outcome = await withFence(h, {
        preCheck: () => { throw new Error('pre fence down'); },
        postCheck: () => 'x',
      }, () => h.exec.executeOne('tool-m2pre', {}, 's6', 'c6').then(
        // 前置围栏故障的方向**与后置相反**：不是"吞掉继续跑"，而是"连跑都不许跑"。
        // 它目前以拒绝（而非结果信封）浮出 —— 那是既有形态，本用例不去改它，只钉住
        // 真正要紧的两件事：工具一次都没跑，且故障没有被静默。
        (result) => ({ result }), (error) => ({ error })));

      assertEquals(ran, 0, '前置围栏故障必须 fail-closed：连一次执行都不许发生');
      const surfaced = outcome.error?.message || outcome.result?.error || '';
      assert(/pre fence down/.test(surfaced),
        `前置围栏故障既不许执行、也不许被静默，实际 "${surfaced}"`);
      console.log(`       [实测] ran=${ran} 浮出="${surfaced}"`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });
}
