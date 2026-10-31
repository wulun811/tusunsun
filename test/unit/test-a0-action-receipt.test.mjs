// A0 回归锁 —— Action Receipt v0（v0.9.33）。
//
// 对应计划书 §5 的 ACT-01 ～ ACT-10。每条都在问同一个问题：
// **回执说的是不是真的？** 而不是"回执有没有那个字段"。
//
// 为什么这个区分要紧：本版回执的唯一价值就是"诚实"。一个填满字段但 hash 来自
// `sha256(我想写的内容)` 的回执，比没有回执更糟 —— 它把意图包装成了事实。
// 所以下面每一条都尽量对着**磁盘真实状态**判，而不是对着回执自洽性判。
//
// 明确的 v0 边界（不测不存在的能力）：
//   · 只有一处备份/条件检查都没有 ⇒ `recovery.supported` 恒为 false，ACT-08 测的是
//     "**没有**误导性 undo_ref"，不是"undo 能用"。
//   · 回执不落盘 ⇒ `persistence` 恒为 `volatile`，ACT-05 测的是"持久化失败时不得
//     谎称已保存"，而本版根本没有持久化路径 —— 所以测的是"如实标 volatile"。
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

rejectNodeTestContext('test/unit/test-a0-action-receipt.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  /** 造一个真 Core + 真 tool-executor，并把真 tool-write 挂在能力上（测回执透出用）。 */
  async function makeExecHost() {
    const d = mkdtempSync(join(tmpdir(), 'a0b-'));
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', d);
    const T = (await imp('plugins/tool-executor.js')).default;
    const exec = Object.create(T);
    exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
    exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
    exec._receipts = new Map(); exec._receiptMax = 100;
    exec._metrics = new Map(); exec._preferences = new Map(); exec._debugStream = null;
    await exec.init(core);
    const tool = Object.create((await imp('plugins/tools/tool-write.js')).default);
    tool.core = core;
    core.registerCapability('tool.write', { owner: 'tool-write', handler: (a) => tool.execute(a) });
    return { d, core, exec, tool };
  }

  /**
   * 造一个装了真 tool-write 的宿主；返回实例与它的回执读取器。
   *
   * AR-C01（v0.10.3）：这里**直接调 `execute()`**（不经过 ToolExecutor），
   * 因此没有可信调用上下文，回执投不进 ALS。工具为此留了 `_directCallReceipt`
   * ——它只服务这类直调方，执行器从不读它，所以它不是共享槽、也不会串台。
   * 修前这里读的是 `inst._lastReceipt`，那个字段正是串台的成因，已删除。
   */
  async function makeHost() {
    const d = mkdtempSync(join(tmpdir(), 'a0-'));
    const core = new Core({ stateDir: join(d, 'state') });
    core.log = () => {};
    core.setData('agent.workDir', d);
    const W = (await imp('plugins/tools/tool-write.js')).default;
    const inst = Object.create(W);
    inst.core = core;
    return { d, core, inst, receipt: () => inst._directCallReceipt };
  }

  // ══ ADR-03（v0.10.0）：capability_not_found 的双侧分歧已消解 ═══════════════
  //
  // ADR-03 原本把它登记为"保留分歧、待决"，理由是"统一必须选一边，两边都有正确性"。
  // 本轮的发现是：它们本来就是**两件事**，不需要选边 ——
  //   "该有的能力装配后没有" ⇒ 装配缺陷 ⇒ failed
  //   "这个工具名没有能力承载" ⇒ 请求无效 ⇒ denied
  // 于是新增 `tool_not_registered`，两个 code 各只有一个归属。
  runner.test('ADR03/a 同一个 code 不得再有两个 state（修前 core 判 failed、执行器判 rejected）', async () => {
    const { Core } = await imp('src/core/core.js');
    const core = new Core({ stateDir: mkdtempSync(join(tmpdir(), 'adr-')) });
    core.log = () => {};
    // core 侧：能力真的不存在 ⇒ failed（装配缺陷）
    const r = await core.callCapability('no.such.capability', {});
    assertEquals(r.code, 'capability_not_found', `core 侧应报 capability_not_found，实际 ${r.code}`);
    assertEquals(r.state, 'failed', '装配缺陷归 failed —— 它该在却没有，不是"你调错了"');
    console.log('       [实测] core: capability_not_found → failed（装配缺陷）');
  });

  runner.test('ADR03/b 未注册成能力的工具必须报 tool_not_registered（不是 capability_not_found）', async () => {
    // 为什么这里是**结构判据**：走 `executeOne` 会先被权限门挡下（实测得到
    // `capability_denied`），根本到不了「未注册成能力」那条分支 —— 第一版就是这么假绿的。
    // 要行为验证就得伪造一整套 legacy 前置条件，那会把测试变成对实现的临摹。
    // 所以退一步钉接线，并把局限写明（与 ACT-01f 同一个处置原则）。
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const i = strip.indexOf('未注册为能力');
    assert(i > 0, '应能找到那条拒绝');
    const tail = strip.slice(i, i + 600);
    assert(/code:\s*'tool_not_registered'/.test(tail),
      '未注册成能力必须抛 tool_not_registered（请求无效）');
    assert(!/code:\s*'capability_not_found'/.test(tail),
      '不得再用 capability_not_found —— 那是装配缺陷的 code，两者不能混');
    const setIdx = strip.indexOf('EXECUTOR_REJECTION_CODES = new Set([');
    assert(setIdx > 0, '应能找到拒绝码集合');
    assert(/tool_not_registered/.test(strip.slice(setIdx, setIdx + 1200)),
      'tool_not_registered 必须在 EXECUTOR_REJECTION_CODES 里，否则会掉进 failed');
    console.log('       [实测] 未注册分支抛 tool_not_registered 且它在拒绝码集合里');
  });

  runner.test('ADR03/c 两个 code 必须都存在于 core 的分类表（不得只加一边）', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    void loadJson5;
    const src = readFileSync(join(ROOT, 'src/core/core.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(/capability_not_found:\s*'failed'/.test(strip),
      'capability_not_found 必须归 failed');
    assert(/tool_not_registered:\s*'denied'/.test(strip),
      'tool_not_registered 必须归 denied —— 两件事必须分开归类');
    // 反向：执行器侧也要把新 code 当拒绝
    const esrc = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    assert(/EXECUTOR_REJECTION_CODES[\s\S]*?tool_not_registered/.test(esrc),
      'executor 的拒绝码集合必须包含 tool_not_registered，否则它会掉进 failed');
    console.log('       [实测] core 两 code 分别归 failed/denied；executor 拒绝码集合含新 code');
  });

  // ══ ACT-01 正常写入：目标文件实际变化，写后 hash 与回执相同 ═══════════════
  runner.test('ACT-01 写入后 after_sha256 必须等于磁盘真相（不是"我想写的"）', async () => {
    const h = await makeHost();
    try {
      const out = await h.inst.execute({ path: 'a.txt', content: 'HELLO' });
      assertEquals(out, 'Written 5 bytes to a.txt', '旧输出必须保持字节不变（无回执模式的兼容性）');

      const r = h.receipt();
      assertEquals(r.schema_version, 'tusunsun.action-receipt/v0', '必须有版本号');
      assertEquals(r.application, 'applied', '正常写入应为 applied');

      const disk = readFileSync(join(h.d, 'a.txt'), 'utf8');
      assertEquals(disk, 'HELLO', '前提：磁盘内容确实是 HELLO');
      assertEquals(r.effect.after_sha256, sha(disk),
        'after_sha256 必须等于**磁盘读回**的 hash');
      assertEquals(r.target.path, 'a.txt', 'target.path 必须是调用方给的路径');
      assertEquals(r.target.canonical_scope, 'cell_workspace', '必须标明作用域');
      console.log('       [实测] after_sha256 == sha256(磁盘读回)，旧输出字节不变');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-01b 修改已有文件：before/after 都必须是真实 hash，且语义正确', async () => {
    const h = await makeHost();
    try {
      writeFileSync(join(h.d, 'b.txt'), 'OLD');
      await h.inst.execute({ path: 'b.txt', content: 'NEW CONTENT' });
      const r = h.receipt();
      assertEquals(r.effect.before_sha256, sha('OLD'), 'before_sha256 必须等于写入前磁盘内容的 hash');
      assertEquals(r.effect.after_sha256, sha('NEW CONTENT'), 'after_sha256 必须等于写入后磁盘内容的 hash');
      assert(r.effect.before_sha256 !== r.effect.after_sha256, '内容变了，两个 hash 必须不同');
      assertEquals(r.effect.kind, 'file_modified', '已存在文件应是 file_modified');
      assertEquals(r.effect.created, false, '不是新建');
      assertEquals(r.effect.changed_bytes, 11 - 3, `差异字节数应为 8，实际 ${r.effect.changed_bytes}`);
      console.log('       [实测] before/after 均为真实 hash，kind=file_modified，diff=+8');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-01c 新建文件：before_sha256 必须是 null（不得伪造）', async () => {
    const h = await makeHost();
    try {
      await h.inst.execute({ path: 'fresh.txt', content: 'X' });
      const r = h.receipt();
      assertEquals(r.effect.before_sha256, null,
        '文件此前不存在 ⇒ before 必须为 null。用空串或 sha256("") 冒充都是伪造');
      assertEquals(r.effect.created, true, '必须标出是新建');
      assertEquals(r.effect.kind, 'file_created', 'kind 必须是 file_created');
      console.log('       [实测] 新建文件：before=null / created=true / kind=file_created');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-01d 写空内容：after_sha256 必须是空内容的真 hash，不是"没写"', async () => {
    // 空内容是合法写入（`R0-146` 修过这条），回执必须把它和应用失败区分开。
    const h = await makeHost();
    try {
      writeFileSync(join(h.d, 'z.txt'), 'SOMETHING');
      const out = await h.inst.execute({ path: 'z.txt', content: '' });
      assertEquals(out, 'Written 0 bytes to z.txt', '空内容写入的旧输出必须保持');
      const r = h.receipt();
      assertEquals(r.application, 'applied', '写空内容是**成功**，不是失败');
      assertEquals(r.effect.after_sha256, sha(''), 'after_sha256 必须是空缓冲区的 hash');
      assertEquals(readFileSync(join(h.d, 'z.txt'), 'utf8'), '', '磁盘上确实是空文件');
      console.log('       [实测] 空内容 → applied 且 after_sha256 == sha256("")');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-01e after_sha256 必须是**读回值**，不是由入参算出的意图值', async () => {
    // ⚠ 这一条是变异实验逼出来的。第一版所有用例都是"写→立刻读回"，两次读到的内容
    // 必然相等，于是 MUT-A0a（把 after_sha256 换成 `sha256(content)`，即意图值）
    // **16 条全绿** —— 那个判据从来没被区分过。这是本项目反复踩的"用意图冒充事实"。
    //
    // 要区分两者，只能让**磁盘内容 ≠ 入参内容**。真实发生的形态有两种，这里都用上：
    //   ① 写入后由别的进程改写（并发写）；
    //   ② 文件系统对内容做了转换。
    // 第 ① 种可以用 `readBack` 直接验证：写完之后外部改盘，再读回，看 hash 跟谁走。
    // 这是**直接测 readBack 这一层的语义**，而 tool-write 的 after_sha256 就来自它。
    const h = await makeHost();
    try {
      const { readBack, sha256Hex } = await imp('plugins/_lib/action-receipt.mjs');
      const f = join(h.d, 'race.txt');
      writeFileSync(f, 'WHAT_I_WROTE');
      // 模拟"写完之后、读回之前，别人改了它"
      writeFileSync(f, 'SOMEONE_ELSE');
      const rb = await readBack(f);
      assertEquals(rb.sha256, sha('SOMEONE_ELSE'),
        'readBack 必须返回**当前磁盘**的 hash —— 若返回写入时的内容 hash，就是在报意图不报事实');
      assertEquals(rb.sha256 === sha('WHAT_I_WROTE'), false,
        'readBack 不得返回"我刚写的内容"的 hash（那证明它没有真的读盘）');
      void sha256Hex;

      // ② 端到端：tool-write 的 after_sha256 必须来自读回。
      // 用"写完之后立刻由外部改写"制造 race —— 由于 writeFile 到 readBack 之间没有 await
      // 之外的间隙，正常情况下无法插入；所以这里改为验证**一致性方向**：
      // 若磁盘内容 == 入参内容，hash 必须等于两者；这是必要条件（不是充分条件），
      // 上面的 readBack 直测才是充分判据。
      await h.inst.execute({ path: 'ok.txt', content: 'SAME' });
      const r = h.receipt();
      assertEquals(r.effect.after_sha256, sha(readFileSync(join(h.d, 'ok.txt'), 'utf8')),
        'after_sha256 必须等于磁盘现状的 hash');
      console.log('       [实测] readBack 返回当前磁盘 hash（外部改写后跟着变），不返回写入意图值');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-01f 结构判据：after_sha256 只能取自 readBack 的返回值', async () => {
    // ⚠ 这一条**明知是结构判据**，理由必须写清，否则它就是本项目批评过的"守排版"。
    //
    // 事实：MUT-A0a（把 `after_sha256: after.sha256` 改成 `after_sha256: intended`）
    // 在 16 条行为用例下**全绿**。原因是那些用例都是"写→立刻读回"，两次内容必然相等，
    // 于是"读回值"与"意图值"在数值上不可区分。
    //
    // 要真正区分，只能在 writeFile 与 readBack 之间插入一次外部改写（或让文件系统
    // 转换内容）。前者是竞态 —— 在进程内无法稳定复现，写成测试只会得到一个偶发假绿；
    // 后者需要一个会转换内容的挂载点。两条都不该为了凑一个"行为判据"而伪造。
    //
    // 所以这里退一步，钉住**接线**：after_sha256 的右值必须是 readBack 的结果变量。
    // 这条判据很窄（只防"有人把右值换成 intended"这一种退化），但它精确、
    // 不误伤，且与上面 ACT-01e（readBack 真的读盘）合起来覆盖完整链条：
    //   ① readBack 返回磁盘现状（行为判据，ACT-01e）
    //   ② after_sha256 取自 readBack 的返回（结构判据，本条）
    // 两者合起来才等价于"after_sha256 是磁盘现状"，单独拿哪一条都不够。
    const src = readFileSync(join(ROOT, 'plugins/tools/tool-write.js'), 'utf8');
    const strip = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(/after_sha256:\s*after\.sha256/.test(strip),
      'after_sha256 必须取自 readBack 的返回值（after.sha256）');
    assert(!/after_sha256:\s*intended/.test(strip),
      'after_sha256 不得取自 intended —— 那是"我要写的"的 hash，属于意图不是事实');
    // 反向：确实存在一次写后读回
    const iWrite = strip.indexOf("await writeFile(fullPath, content");
    const iRead = strip.indexOf('const after = await readBack(fullPath)');
    assert(iWrite > 0 && iRead > iWrite,
      '必须存在"写入之后"的读回（readBack 在 writeFile 之后）—— 顺序反了就等于在读旧值');
    console.log('       [实测] after_sha256 ← after.sha256，且 readBack 位于 writeFile 之后');
  });

  // ══ A0-b（v0.10.0）：回执必须真的**被模型看见** ═══════════════════════════
  //
  // v0.9.33 只把回执挂在 `tool-write` 的 `_lastReceipt` 上 —— 数据有了，但执行器不读、
  // 模型看不到。Track A 的目的正是"让 Cell 看清自己造成的变化"，只做数据等于没做。
  runner.test('A0-b/1 工具输出必须带上回执摘要（否则模型仍然只看到 "Written N bytes"）', async () => {
    const h = await makeExecHost();
    try {
      // 让执行器能解析到工具实例（回执挂在实例上）
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-write' ? h.tool : null),
        has: (n) => n === 'tool-write',
        listTools: () => [],
      });
      const r = await h.exec.executeOne('tool-write', { path: 'n.txt', content: 'HELLO' }, 's1', 'c1');
      assertEquals(r.state, 'succeeded', `前提：写入应成功，实际 ${r.state} ${r.error}`);
      const text = String(r.result);
      assert(text.startsWith('Written 5 bytes to n.txt'),
        `旧输出必须仍然在最前面（不变量），实际 "${text.slice(0, 60)}"`);
      assert(/\[回执 act-/.test(text),
        `必须附上回执摘要 —— 否则模型仍无从判断改了多少，实际 "${text}"`);
      assert(/差异 1 字节|差异 5 字节|新建 n\.txt/.test(text),
        `摘要必须给出可判断的事实（新建/差异字节），实际 "${text}"`);
      assert(/不可撤销/.test(text), '摘要必须明说不可撤销');
      assert(/action\.inspect/.test(text), '摘要必须给出按需展开的引用');
      console.log(`       [实测] 输出 = "${text}"`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('A0-b/2 没有回执的工具，输出必须**字节不变**（零侵入）', async () => {
    const h = await makeExecHost();
    try {
      h.core.registerCapability('tool.plain', { owner: 'plain', handler: async () => 'PLAIN OUTPUT' });
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'plain' ? { name: 'plain' } : null),
        has: () => false, listTools: () => [],
      });
      const r = await h.exec.executeOne('tool-plain', { x: 1 }, 's1', 'c1');
      assertEquals(r.result, 'PLAIN OUTPUT',
        `没有回执的工具输出必须字节不变（这是"零侵入"的判据），实际 "${r.result}"`);
      console.log('       [实测] 无回执工具的输出原样返回');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('A0-b/3 摘要与留档都必须有界（不把上下文/内存吃光）', async () => {
    const h = await makeExecHost();
    try {
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-write' ? h.tool : null),
        has: () => true, listTools: () => [],
      });
      const big = 'X'.repeat(40000);
      const r = await h.exec.executeOne('tool-write', { path: 'b.txt', content: big }, 's1', 'c1');
      const text = String(r.result);
      assert(text.length < 500,
        `带 40KB 内容的写入，输出必须仍很短（附注有上限），实际 ${text.length} 字符`);
      assert(!text.includes('XXXX'), '摘要不得包含文件内容');
      // 留档有界。**不走 executeOne**：实测那条路径会因为缓存/去重只留 30 条，
      // 于是"≤100"这条断言在空转 —— 变异（去掉淘汰循环）照样全绿。
      // 改为直接打 `_receiptNote` 的边界：它才是做淘汰的地方，也才是该被守住的东西。
      // AR-C01（v0.10.3）：`_receiptNote` 不再从工具实例读，而是从**本次调用上下文**取。
      // 所以这里必须在一个调用上下文里投放回执，才能真的打到那条留档/淘汰路径上。
      const { runInCallContext, publishReceipt } = await imp('plugins/_lib/call-context.mjs');
      for (let i = 0; i < 250; i++) {
        runInCallContext({ callId: `c${i}`, sessionId: 's1', tool: 'tool-write' }, () => {
          publishReceipt({ action_id: `act-test-${i}`, application: 'applied',
            target: { path: `f${i}.txt` }, effect: {}, verification: 'not_run',
            recovery: { supported: false }, persistence: 'volatile' });
          h.exec._receiptNote('s1');
        });
      }
      assertEquals(h.exec._receipts.size, 100,
        `回执留档必须是硬上限 100（不是"大约"），实际 ${h.exec._receipts.size} —— `
        + '无界增长是一种慢速内存泄漏');
      // 反向：留下的必须是最新的 100 条，不是最旧的 100 条
      assert(h.exec._receipts.has('act-test-249'),
        '必须保留**最新**的回执（淘汰最旧的），否则 action.inspect 只能拿到过时明细');
      assert(!h.exec._receipts.has('act-test-0'), '最旧的应被淘汰');
      console.log(`       [实测] 40KB 内容 → 输出 ${text.length} 字符；写 250 条回执 → 留档恰好 ${h.exec._receipts.size} 条（保留最新）`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('A0-b/4 action.inspect 必须能按 id 展开（工具输出里的提示要有东西可调）', async () => {
    const h = await makeExecHost();
    try {
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-write' ? h.tool : null),
        has: () => true, listTools: () => [],
      });
      const r = await h.exec.executeOne('tool-write', { path: 'i.txt', content: 'ABC' }, 's1', 'c1');
      const m = String(r.result).match(/action\.inspect (act-[A-Za-z0-9-]+)/);
      assert(m, `工具输出里必须给出可用的 action_id，实际 "${r.result}"`);
      const id = m[1];

      const got = await h.exec.inspectAction(id, 's1', 5000);
      assertEquals(got.ok, true, `应能展开，实际 ${got.code} ${got.error}`);
      assertEquals(got.receipt.action_id, id, 'id 必须一致');
      assertEquals(got.receipt.application, 'applied', '明细里的应用状态必须是真的');
      assertEquals(typeof got.receipt.effect.after_sha256, 'string', '明细必须含 after_sha256');
      assertEquals(got.receipt.recovery.supported, false, '明细必须如实说不可撤销');
      console.log(`       [实测] 从输出里取到 ${id} 并展开成功（含 after_sha256，recovery=false）`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('A0-b/5 action.inspect 必须按 session 隔离（不得跨会话窥探别人的动作）', async () => {
    const h = await makeExecHost();
    try {
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-write' ? h.tool : null),
        has: () => true, listTools: () => [],
      });
      const r = await h.exec.executeOne('tool-write', { path: 's.txt', content: 'S' }, 'session-A', 'c1');
      const id = String(r.result).match(/action\.inspect (act-[A-Za-z0-9-]+)/)[1];

      const own = await h.exec.inspectAction(id, 'session-A', 5000);
      assertEquals(own.ok, true, '自己的会话必须能读');

      const other = await h.exec.inspectAction(id, 'session-B', 5000);
      assertEquals(other.ok, false, '别的会话不得读到自己没产生的动作明细');
      assertEquals(other.code, 'receipt_not_yours', `必须报具名 receipt_not_yours，实际 ${other.code}`);
      console.log('       [实测] session-A 可读、session-B 被拒（receipt_not_yours）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('A0-b/6 action.inspect 的预算必须真的截断，且明说被截断', async () => {
    const h = await makeExecHost();
    try {
      h.core.registerService('tool-registry', {
        get: async (n) => (n === 'tool-write' ? h.tool : null),
        has: () => true, listTools: () => [],
      });
      const r = await h.exec.executeOne('tool-write', { path: 't.txt', content: 'T' }, 's1', 'c1');
      const id = String(r.result).match(/action\.inspect (act-[A-Za-z0-9-]+)/)[1];

      const tight = await h.exec.inspectAction(id, 's1', 80);
      assertEquals(tight.ok, true, '预算小也应该成功（截断而不是失败）');
      assertEquals(tight.truncated, true, '超预算必须标 truncated');
      assertEquals(tight.receipt_text.length, 80, `截断长度必须等于预算，实际 ${tight.receipt_text.length}`);
      assert(/truncated/.test(tight.note), '必须明说被截断，不能静默丢字段');
      assert(tight.full_length > 80, '必须报出完整长度，让调用方知道丢了多少');

      const missing = await h.exec.inspectAction('act-nope', 's1', 500);
      assertEquals(missing.ok, false, '查不到必须失败');
      assertEquals(missing.code, 'receipt_not_found', `必须具名 receipt_not_found，实际 ${missing.code}`);
      console.log(`       [实测] 预算 80 → 截断到 80 且标 truncated；未知 id → receipt_not_found`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-02 路径越界：写入被阻止，无产物，回执不得标 applied ═══════════════
  runner.test('ACT-02 路径越界必须拒绝且不留产物，回执不得标 applied', async () => {
    const h = await makeHost();
    try {
      let threw = null;
      try { await h.inst.execute({ path: '../escape.txt', content: 'X' }); }
      catch (e) { threw = e; }
      assert(threw, '越界写入必须抛错（不得静默成功）');
      assertEquals(threw.code, 'out_of_bounds', `必须具名 out_of_bounds，实际 ${threw.code}`);
      assertEquals(existsSync(join(h.d, '../escape.txt')), false, '越界路径不得产生文件');
      // 被拒时**不应该**产生一份"applied"的回执
      const r = h.receipt();
      assert(!r || r.application !== 'applied',
        `被拒绝的写入不得留下 applied 回执，实际 ${JSON.stringify(r?.application)}`);
      console.log('       [实测] 越界 → out_of_bounds，无产物，回执未标 applied');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-02b 符号链接越界同样不得 applied，且不得改写外部文件', async () => {
    const { symlinkSync, mkdirSync } = await import('node:fs');
    const h = await makeHost();
    const outside = mkdtempSync(join(tmpdir(), 'a0out-'));
    try {
      writeFileSync(join(outside, 'k.txt'), 'ORIGINAL');
      mkdirSync(join(h.d, 'sub'), { recursive: true });
      symlinkSync(outside, join(h.d, 'vault'));
      let threw = null;
      try { await h.inst.execute({ path: 'vault/k.txt', content: 'HACKED' }); }
      catch (e) { threw = e; }
      assert(threw, '经符号链接越界必须抛错');
      assertEquals(readFileSync(join(outside, 'k.txt'), 'utf8'), 'ORIGINAL',
        '外部文件内容必须没变');
      const r = h.receipt();
      assert(!r || r.application !== 'applied', '不得留下 applied 回执');
      console.log('       [实测] 符号链接越界被拒，外部文件未变');
    } finally { rmSync(h.d, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  // ══ ACT-03 写入出错：返回 failed，磁盘状态与回执一致 ══════════════════════
  runner.test('ACT-03 写入失败必须报具名错误，且回执不得声称 applied', async () => {
    const h = await makeHost();
    try {
      // 把目标指向一个**已存在的目录**：写它必然 EISDIR
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(h.d, 'adir'));
      let threw = null;
      try { await h.inst.execute({ path: 'adir', content: 'X' }); }
      catch (e) { threw = e; }
      assert(threw, '写目录必须失败');
      assertEquals(threw.code, 'resource_error', `必须具名 resource_error，实际 ${threw.code}`);
      const r = h.receipt();
      assert(!r || r.application !== 'applied',
        `失败不得留下 applied 回执，实际 ${JSON.stringify(r?.application)}`);
      console.log('       [实测] EISDIR → resource_error，无 applied 回执');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-05 只生成回执、持久化失败 → volatile / 不谎称审计永久可靠 ═════════
  runner.test('ACT-05 persistence 必须如实标 volatile（回执不落盘，不得谎称已保存）', async () => {
    const h = await makeHost();
    try {
      await h.inst.execute({ path: 'p.txt', content: 'P' });
      const r = h.receipt();
      assertEquals(r.persistence, 'volatile',
        '回执只随返回值返回、不落盘 ⇒ 必须是 volatile。标 persisted 会让调用方以为审计永久可靠');
      // 反向：不得出现 persisted 这个说法
      assert(r.persistence !== 'persisted', '本版没有持久化路径，不得写 persisted');
      console.log('       [实测] persistence=volatile（回执不落盘，如实标注）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-08 无法撤销的原生工具：recovery.supported=false，无误导性 undo_ref ══
  runner.test('ACT-08 原生写盘不可撤销：recovery.supported 必须 false 且无 undo 引用', async () => {
    const h = await makeHost();
    try {
      await h.inst.execute({ path: 'r.txt', content: 'R' });
      const r = h.receipt();
      assertEquals(r.recovery.supported, false,
        '本版没有备份与条件检查 —— 标 true 就是承诺一个不存在的能力');
      assertEquals(r.recovery.ref, null, '不得给出一个指向不存在的 undo 的引用');
      // 摘要里必须说出来，否则读者会默认"能撤销"
      const { summarizeReceipt } = await imp('plugins/_lib/action-receipt.mjs');
      assert(/不可撤销/.test(summarizeReceipt(r)),
        `人类可读摘要必须明说不可撤销，实际 "${summarizeReceipt(r)}"`);
      console.log('       [实测] recovery.supported=false / ref=null / 摘要写明不可撤销');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-09 上下文预算：自动反馈有上限，细节可按需读取 ════════════════════
  runner.test('ACT-09 摘要必须有界：不把文件内容塞进自动反馈', async () => {
    const { summarizeReceipt } = await imp('plugins/_lib/action-receipt.mjs');
    const h = await makeHost();
    try {
      const big = 'X'.repeat(50000);
      await h.inst.execute({ path: 'big.txt', content: big });
      const r = h.receipt();
      const summary = summarizeReceipt(r);
      assert(summary.length < 300,
        `摘要必须短（模型自动反馈有预算），实际 ${summary.length} 字符`);
      assert(!summary.includes('XXXX'),
        '摘要不得包含文件内容 —— 那会把上下文预算一次性烧掉');
      // 文件内容确实很大，但回执里也不该有它
      assertEquals(JSON.stringify(r).includes('XXXX'), false,
        '回执本身也不得复制文件内容（敏感内容遮盖的第一道防线）');
      console.log(`       [实测] 50KB 内容 → 摘要 ${summary.length} 字符且不含内容`);
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  runner.test('ACT-09b verification 与 application 必须是两个独立的轴', async () => {
    const h = await makeHost();
    try {
      await h.inst.execute({ path: 'v.txt', content: 'V' });
      const r = h.receipt();
      assertEquals(r.application, 'applied', '写入成功了，application 就是 applied');
      assertEquals(r.verification, 'not_run',
        '没有做独立验证就必须是 not_run —— applied 不妨碍 not_run，两者是分开的轴');
      console.log('       [实测] application=applied 且 verification=not_run 并存（两轴独立）');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ ACT-10 旧场景未启用此组件：旧语义与安装路径不退化 ════════════════════
  runner.test('ACT-10 旧输出必须字节不变（回执是附加信息，不是替换）', async () => {
    const h = await makeHost();
    try {
      const cases = [
        [{ path: 'x.txt', content: 'abc' }, 'Written 3 bytes to x.txt'],
        [{ path: 'x.txt', content: '' }, 'Written 0 bytes to x.txt'],
        [{ path: 'x.txt', content: '中文内容' }, 'Written 4 bytes to x.txt'],
      ];
      for (const [args, expect] of cases) {
        const out = await h.inst.execute(args);
        assertEquals(out, expect,
          `旧输出必须完全一致（模型看到的文本字节不变）—— 实际 "${out}"`);
      }
      console.log('       [实测] 三种写入的返回值与 v0.9.32 字节一致');
    } finally { rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ 回执自洽性：buildReceipt 必须拒绝不诚实的组合 ═════════════════════════
  runner.test('A0/R1 buildReceipt 必须拒"applied 但没有 after_sha256"', async () => {
    const { buildReceipt } = await imp('plugins/_lib/action-receipt.mjs');
    const r = buildReceipt({ application: 'applied', effect: {} });
    assertEquals(r.ok, false, 'applied 却没有 after_sha256 必须被拒');
    assert(r.violations.some((v) => /after_sha256/.test(v)), '违反项必须点名 after_sha256');
    console.log('       [实测] applied 缺 after_sha256 → 拒绝并点名');
  });

  runner.test('A0/R2 buildReceipt 必须拒"rejected 却带 effect"', async () => {
    const { buildReceipt } = await import(join(ROOT, 'plugins/_lib/action-receipt.mjs'));
    const r = buildReceipt({ application: 'rejected', effect: { after_sha256: 'x' } });
    assertEquals(r.ok, false, 'rejected 带 effect 必须被拒（拒绝 = 没有效果）');
    console.log('       [实测] rejected 带 effect → 拒绝');
  });

  runner.test('A0/R3 buildReceipt 必须拒"recovery.supported=true 但没有 ref"', async () => {
    const { buildReceipt } = await import(join(ROOT, 'plugins/_lib/action-receipt.mjs'));
    const r = buildReceipt({
      application: 'applied', effect: { after_sha256: 'a'.repeat(64) },
      recovery: { supported: true, ref: null },
    });
    assertEquals(r.ok, false, '声称能恢复却不给引用必须被拒（空承诺）');
    console.log('       [实测] supported=true 缺 ref → 拒绝');
  });

  runner.test('A0/R4 摘要不得生成推测数字（拿不到就不写）', async () => {
    const { summarizeReceipt, buildReceipt } = await import(join(ROOT, 'plugins/_lib/action-receipt.mjs'));
    const built = buildReceipt({
      application: 'applied',
      effect: { after_sha256: 'b'.repeat(64), changed_bytes: null },
    });
    assert(built.ok, '此组合应合法');
    const s = summarizeReceipt(built.receipt);
    assert(!/\d+ 字节/.test(s),
      `changed_bytes 未知时不得写出字节数（不生成推测值），实际 "${s}"`);
    console.log(`       [实测] changed_bytes=null → 摘要无字节数："${s}"`);
  });
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEquals failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assert failed');
}
