// S1 / S2 / S3 回归锁 —— v0.9.33 的 A 门（发布硬门）三条。
//
// 这三条都是 v0.9.32 送审包里**已知未修**的问题，报告 §1.1 与 §3 记录在案，
// 并由探针 `test/probes/r0-159-sandbox-symlink-bypass.mjs` 以"故意红"的方式暴露。
// 本轮（v0.9.33）修掉之后，它们从"探针里的已知缺陷"升级成"这里的回归锁"。
//
// 与探针的分工没有变：
//   · 探针 = 给人工看"当前还缺什么"（可以红）；
//   · 这里是回归锁 = 修好的东西不许退化（必须绿，红了就阻塞发布）。
//
// 每条都要求**实际磁盘/进程副作用证据**，不接受"返回文本里出现了某个词"。
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, lstatSync } from 'node:fs';
import { rejectNodeTestContext } from '../lib/node-test-guard.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));

rejectNodeTestContext('test/unit/test-s1-s2-s3-execution-boundary.test.mjs');

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');

  /** 造一个 init 过的 sandbox 实例，配置由调用方给全。 */
  async function makeSandbox(base, cfg = {}) {
    const core = new Core({ stateDir: join(base, 'state') });
    core.log = () => {};
    const table = { 'sandbox.workDir': join(base, 'ws'), ...cfg };
    core.registerService('config', { get: (k, fb) => (k in table ? table[k] : fb) });
    const S = (await imp('plugins/sandbox.js')).default;
    const saved = {
      deny: S._deny, readAllow: S._readAllow, writeAllow: S._writeAllow,
      bashAllowlist: S._bashAllowlist, workDir: S._workDir, timeout: S._timeout,
      core: S.core,
    };
    await S.init(core);
    return { S, core, restore: () => { S.stop(); Object.assign(S, saved); } };
  }

  function tmp(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  // ══ S1 / R0-159：文件边界必须真实路径化 ══════════════════════════════════
  //
  // 修前实测（探针记录）：`deny=[secret]`，工作区里 `vault -> secret`，
  // 写 `ws/vault/k.txt` 被判"在工作区内"，磁盘上 `secret/k.txt` 真的变成 HACKED-VIA-LINK。
  runner.test('S1/a 经符号链接写 deny 目录必须被拒，且磁盘不得有任何变化', async () => {
    const d = tmp('s1a-');
    try {
      const ws = join(d, 'ws'); const secret = join(d, 'secret');
      mkdirSync(ws); mkdirSync(secret);
      writeFileSync(join(secret, 'k.txt'), 'ORIGINAL');
      symlinkSync(secret, join(ws, 'vault'));

      const h = await makeSandbox(d, { 'sandbox.deny': [secret] });
      try {
        const r = await h.S.execute('write', { path: join(ws, 'vault', 'k.txt'), content: 'HACKED' });
        assertEquals(r.ok, false, `经符号链接写 deny 目录必须被拒，实际 ok=${r.ok} code=${r.code}`);
        assertEquals(r.blocked, true, '拒绝必须是显式 blocked，不能只是一条 error 文案');
        // **关键判据**：不看返回文本，看磁盘。修前这里的内容会被改写。
        const after = readFileSync(join(secret, 'k.txt'), 'utf8');
        assertEquals(after, 'ORIGINAL',
          `磁盘内容必须没变 —— 修前这里是 "HACKED-VIA-LINK"，实际 "${after}"`);
        console.log('       [实测] 符号链接写 deny 目录 → 拒绝，secret/k.txt 内容仍为 ORIGINAL');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/b 直达 deny 目录仍必须被拒（修符号链接不能把旧保护弄丢）', async () => {
    const d = tmp('s1b-');
    try {
      const ws = join(d, 'ws'); const secret = join(d, 'secret');
      mkdirSync(ws); mkdirSync(secret);
      const h = await makeSandbox(d, { 'sandbox.deny': [secret] });
      try {
        const r = await h.S.execute('write', { path: join(secret, 'x.txt'), content: 'X' });
        assertEquals(r.ok, false, '直达 deny 目录必须被拒');
        assertEquals(existsSync(join(secret, 'x.txt')), false, '被拒时不得有产物');
        console.log('       [实测] 直达 deny → 拒绝，无产物');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/c 嵌套符号链接（父目录是链接）同样必须被拒', async () => {
    // 只判末级 realpath 是不够的：`ws/a/b/k.txt` 里 `a -> /outside` 时，
    // 末级 `k.txt` 自己可能不存在，逃逸发生在**已存在的祖先**上。
    const d = tmp('s1c-');
    try {
      const ws = join(d, 'ws'); const outside = join(d, 'outside');
      mkdirSync(ws); mkdirSync(outside);
      symlinkSync(outside, join(ws, 'a'));

      const h = await makeSandbox(d, { 'sandbox.deny': [outside] });
      try {
        const r = await h.S.execute('write', { path: join(ws, 'a', 'b', 'k.txt'), content: 'NESTED' });
        assertEquals(r.ok, false, `父目录是符号链接时也必须被拒，实际 ok=${r.ok}`);
        assertEquals(existsSync(join(outside, 'b', 'k.txt')), false, '被拒时不得在外部产生文件');
        console.log('       [实测] 嵌套符号链接（父目录为链接）→ 拒绝，外部无产物');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/d 前缀同名目录不得被误判为 deny 内部（/etcx 不是 /etc）', async () => {
    const d = tmp('s1d-');
    try {
      // S1（rc.15）：兄弟目录必须放在**工作区之内**。
      // `makeSandbox` 把 `sandbox.workDir` 设成 `d/ws`，而旧的 `d/secret_evil` 落在工作区外 ——
      // 新合同下那里会被“工作区边界”先拒，测到的不再是“前缀 vs 包含”。被测属性不变：
      // deny 是**目录包含**，`secret_evil` 不是 `secret`。
      const ws = join(d, 'ws'); const denyDir = join(ws, 'secret'); const sibling = join(ws, 'secret_evil');
      mkdirSync(ws); mkdirSync(denyDir); mkdirSync(sibling);
      writeFileSync(join(sibling, 'ok.txt'), 'SIBLING');
      const h = await makeSandbox(d, { 'sandbox.deny': [denyDir] });
      try {
        const r = await h.S.execute('read', { path: join(sibling, 'ok.txt') });
        assertEquals(r.ok, true,
          `同级前缀目录不得被 deny 误伤（包含关系而非字符串前缀），实际 ok=${r.ok} error=${r.error}`);
        console.log('       [实测] secret_evil 不被 secret 的 deny 误伤');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/e 合法读写不得退化（修复不能变成"什么都拒绝"）', async () => {
    const d = tmp('s1e-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      mkdirSync(join(ws, 'sub'));
      const h = await makeSandbox(d, { 'sandbox.writeAllow': [ws], 'sandbox.readAllow': [ws] });
      try {
        const w = await h.S.execute('write', { path: join(ws, 'sub', 'ok.txt'), content: 'HELLO' });
        assertEquals(w.ok, true, `工作区内的合法写入必须放行，实际 ok=${w.ok} error=${w.error}`);
        assertEquals(readFileSync(join(ws, 'sub', 'ok.txt'), 'utf8'), 'HELLO', '合法写入必须真的落盘');
        const r = await h.S.execute('read', { path: join(ws, 'sub', 'ok.txt') });
        assertEquals(r.ok, true, '工作区内的合法读取必须放行');
        assertEquals(r.data, 'HELLO', '读回的内容必须与写入一致');
        console.log('       [实测] 合法写/读均放行且内容一致');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/f 路径不可确定时必须 fail-closed（不是放行）', async () => {
    const d = tmp('s1f-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.writeAllow': [ws] });
      try {
        for (const bad of ['', null, undefined, 123, {}]) {
          const r = await h.S.execute('write', { path: bad, content: 'x' });
          assertEquals(r.ok, false, `非法路径形态 ${JSON.stringify(bad)} 必须被拒，实际 ok=${r.ok}`);
        }
        // 相对路径：workDir 存在时必须能解析；解析不了必须拒，不能按进程 cwd 猜
        const rel = await h.S.execute('write', { path: 'rel.txt', content: 'R' });
        assertEquals(rel.ok, true, `相对路径应相对 sandbox.workDir 解析，实际 ok=${rel.ok} error=${rel.error}`);
        assertEquals(existsSync(join(ws, 'rel.txt')), true, '相对路径必须真的落在配置的工作区里');
        h.S._workDir = null;
        const noBase = await h.S.execute('write', { path: 'rel2.txt', content: 'R' });
        assertEquals(noBase.ok, false,
          '没有解析基准时相对路径必须 fail-closed —— 不得回落到 process.cwd() 去猜');
        console.log('       [实测] 非法形态全拒；相对路径按 workDir 解析；无基准时 fail-closed');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/g 判据必须与执行落在同一位置（判据给出的物理路径就是真正被用的路径）', async () => {
    // 合同原话："不能先查 A，随后让子进程在 B 写入"。
    // 这里的判据方式：`_guard` 返回的 `path` 必须是**物理**路径，
    // 且 `execute` 必须把这个 path 交给子进程（而不是原始入参）。
    const d = tmp('s1g-');
    try {
      const ws = join(d, 'ws'); const real = join(d, 'realdir');
      mkdirSync(ws); mkdirSync(real);
      symlinkSync(real, join(ws, 'alias'));
      const h = await makeSandbox(d, { 'sandbox.writeAllow': [d] });
      try {
        const g = await h.S._guard('write', { path: join(ws, 'alias', 'f.txt') });
        assertEquals(g.ok, true, '在 allow 范围内的链接目标应放行');
        assertEquals(g.path, join(real, 'f.txt'),
          `_guard 必须返回物理路径（把 alias 解开），实际 ${g.path}`);
        assert(!g.path.includes('alias'), `返回的路径里不得还留着需要穿透的符号链接：${g.path}`);
        console.log(`       [实测] 判据返回物理路径 ${g.path}（已解开 alias）`);
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S1/h 被拒的操作不得留下子进程（判据必须在 fork 之前）', async () => {
    const d = tmp('s1h-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.deny': [ws] });
      try {
        h.S._children.clear();
        await h.S.execute('write', { path: join(ws, 'x.txt'), content: 'X' });
        assertEquals(h.S._children.size, 0,
          `被拒的操作不应 fork 出子进程，实际留下 ${h.S._children.size} 个 —— 拒绝本该没有副作用`);
        console.log('       [实测] 拒绝路径 0 个子进程');
      } finally { await h.S.killAll(); h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ S2 / R0-160：不得保留误导性的 shell 白名单 ═══════════════════════════
  //
  // 修前实测：`bashAllowlist=['echo']` 时 `echo pwned; touch /tmp/x` 首 token 是 `echo`
  // ⇒ 放行，后半段真的执行。修法选"承认这个策略不可实施"，于是配置白名单后一律具名拒绝。
  const COMPOUND = [
    ['分号复合命令', 'echo ok; touch PWNED_SEMI'],
    ['管道', 'echo ok | tee PWNED_PIPE'],
    ['重定向', 'echo ok > PWNED_REDIR'],
    ['命令替换 $(...)', 'echo $(touch PWNED_SUBST)'],
    ['反引号替换', 'echo `touch PWNED_BACKTICK`'],
    ['换行分隔', 'echo ok\ntouch PWNED_NEWLINE'],
    ['前缀伪装 echooo', 'echooo PWNED_PREFIX'],
    ['前缀伪装 echo-hack', 'echo-hack PWNED_HYPHEN'],
    ['&& 串联', 'echo ok && touch PWNED_AND'],
  ];

  runner.test('S2/a 配置了 bashAllowlist 时，任何复合命令都不得从受限档通过', async () => {
    const d = tmp('s2a-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.bashAllowlist': ['echo'] });
      try {
        for (const [name, tpl] of COMPOUND) {
          const marker = join(ws, tpl.split(' ').pop());
          const cmd = tpl.replace(tpl.split(' ').pop(), marker);
          const r = await h.S.execute('bash', { command: cmd });
          assertEquals(r.ok, false, `${name} 必须被拒（受限档无法实施白名单），实际 ok=${r.ok}`);
          assertEquals(r.code, 'unsupported_restricted_shell',
            `${name} 必须报具名 unsupported_restricted_shell，实际 ${r.code}`);
          // **关键判据**：不是看返回文本，是看标记文件有没有被创建。
          assertEquals(existsSync(marker), false,
            `${name} 被拒时不得产生副作用，实际 ${marker} 存在`);
        }
        console.log(`       [实测] ${COMPOUND.length} 类复合命令全部具名拒绝，0 个标记文件`);
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S2/b 拒绝不得悄悄回退成开放执行（同一实例再调仍拒绝）', async () => {
    // "第一次拒绝、之后放行"是比一直拒绝更糟的失败模式：调用方会学到"重试就好"。
    const d = tmp('s2b-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.bashAllowlist': ['echo'] });
      try {
        for (let i = 0; i < 3; i++) {
          const r = await h.S.execute('bash', { command: 'echo ok' });
          assertEquals(r.ok, false, `第 ${i + 1} 次调用也必须拒绝，不得回退`);
          assertEquals(r.code, 'unsupported_restricted_shell', `第 ${i + 1} 次必须是同一个具名 code`);
        }
        console.log('       [实测] 连续 3 次调用稳定拒绝，无回退');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S2/c 未配置白名单时 shell 仍可用（可信高权限档不得被误伤）', async () => {
    const d = tmp('s2c-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.bashAllowlist': [] });
      try {
        const r = await h.S.execute('bash', { command: `echo TRUSTED_TIER_OK` });
        assertEquals(r.ok, true, `未配置白名单时 shell 应可用，实际 ok=${r.ok} error=${r.error}`);
        assert(String(r.data).includes('TRUSTED_TIER_OK'), `命令输出应被回传，实际 ${JSON.stringify(r.data)}`);
        console.log('       [实测] 无白名单配置 → shell 正常执行');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S2/d 空命令必须被拒（不得当成"没有命令所以不需要检查"）', async () => {
    const d = tmp('s2d-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      for (const cfg of [{ 'sandbox.bashAllowlist': [] }, { 'sandbox.bashAllowlist': ['echo'] }]) {
        const h = await makeSandbox(d, cfg);
        try {
          const r = await h.S.execute('bash', { command: '   ' });
          assertEquals(r.ok, false, `空命令必须被拒（配置 ${JSON.stringify(cfg)}）`);
        } finally { h.restore(); }
      }
      console.log('       [实测] 空命令在两种配置下都被拒');
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ S3 / R0-161：超时必须如实说明"请求截止 ≠ 执行结束" ═══════════════════
  //
  // 修前实测（专家反例）：75ms 返回超时，约 650ms 后文件才被创建。
  // 外层 Promise 已 resolve，子进程里的 `execSync` 还在跑。
  runner.test('S3/a 超时回执必须区分"请求截止"与"执行状态未知"，且不谎报已终止', async () => {
    const d = tmp('s3a-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.timeout': 40000 });
      try {
        const t0 = Date.now();
        const r = await h.S.execute('bash', { command: 'sleep 5' }, { timeout: 120 });
        const elapsed = Date.now() - t0;
        assertEquals(r.ok, false, '超时必须是非成功');
        assertEquals(r.request_state, 'timed_out',
          `必须显式说"这是请求的截止"，实际 request_state=${r.request_state}`);
        assertEquals(r.execution_state, 'unknown_or_running',
          `不得把超时说成执行已结束，实际 execution_state=${r.execution_state}`);
        assertEquals(r.execution_may_continue, true, '必须承认副作用可能还在发生');
        assertEquals(r.terminated_confirmed, false,
          '不得把"kill 调过"写成"已确认终止" —— 那正是本合同禁止的谎报');
        assert(typeof r.request_id === 'string' && r.request_id.length > 0, '必须有可关联的 request_id');
        assert(elapsed < 3000,
          `超时必须真的按时收束（不能在等待里把超时拖成等结束），实际 ${elapsed}ms`);
        console.log(`       [实测] ${elapsed}ms 收束：request_state=timed_out / `
          + 'execution_state=unknown_or_running / terminated_confirmed=false');
      } finally { await h.S.killAll(); h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S3/b 迟到的回复不得覆盖已收束的超时结论（串台通道）', async () => {
    // 修前：超时分支只清理 pending，**不摘 message 监听器** ——
    // 于是同一次请求的迟到回复仍会触发 `sandbox.result`，形成"超时之后自己变成成功"。
    const d = tmp('s3b-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.timeout': 40000 });
      const events = [];
      try {
        h.core.emitFast = (name, payload) => { events.push({ name, payload }); };
        const r = await h.S.execute('bash', { command: 'sleep 1; echo LATE' }, { timeout: 150 });
        assertEquals(r.request_state, 'timed_out', '前提：这一次应超时');
        // 等到子进程自己把结果发回来
        await new Promise((res) => setTimeout(res, 1500));
        const resultEvents = events.filter((e) => e.name === 'sandbox.result');
        assertEquals(resultEvents.length, 0,
          `超时之后不得再广播 sandbox.result（那等于让超时请求变成成功），实际 ${resultEvents.length} 条`);
        const lateEvents = events.filter((e) => e.name === 'sandbox.late_result');
        assert(lateEvents.length >= 1,
          `迟到的回复应作为 late_result 留痕，实际 ${lateEvents.length} 条；事件=${events.map((e) => e.name).join(',')}`);
        console.log(`       [实测] 迟到回复只产生 ${lateEvents.length} 条 late_result，0 条 result`);
      } finally { await h.S.killAll(); h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S3/c 通道已关闭时不得挂死（child.send 同步抛必须被收束）', async () => {
    const d = tmp('s3c-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, {});
      try {
        const fake = { pid: 999999, connected: false, on() {}, removeListener() {}, send() { throw new Error('channel closed'); } };
        const r = await h.S._execWithTimeout(fake, 'read', { path: join(ws, 'a') }, 1, 'default', 's', 5000);
        assertEquals(r.ok, false, '通道关闭必须回失败，而不是让调用方永远挂着');
        assertEquals(r.code, 'sandbox_channel_closed', `应报具名码，实际 ${r.code}`);
        console.log('       [实测] child.send 抛错被收束为 sandbox_channel_closed');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ 跨路径一致性（Contract Trace 的 Cross-path equivalence） ═════════════
  runner.test('X/1 同一路径在工具层与沙箱层必须给出同一个结论（S1 的核心论据）', async () => {
    // 修前这就是那个缺口：工具层拒、沙箱层放。现在两边共用 `_lib/real-path.mjs`。
    const d = tmp('x1-');
    try {
      const ws = join(d, 'ws'); const secret = join(d, 'secret');
      mkdirSync(ws); mkdirSync(secret);
      writeFileSync(join(secret, 'k.txt'), 'ORIGINAL');
      symlinkSync(secret, join(ws, 'vault'));

      const h = await makeSandbox(d, { 'sandbox.deny': [secret] });
      const { resolveWorkspacePath } = await imp('plugins/tools/lib/workspace.mjs');
      try {
        let toolLayerDenied = false;
        try { await resolveWorkspacePath(ws, 'vault/k.txt'); } catch { toolLayerDenied = true; }
        const sg = await h.S._guard('write', { path: join(ws, 'vault', 'k.txt') });
        assertEquals(toolLayerDenied, true, '前提：工具层必须拒绝这条路径');
        assertEquals(sg.ok, false,
          '沙箱层必须给出**同一个**结论 —— 两个入口两个答案是送审报告 §1.1 的核心问题');
        console.log('       [实测] 工具层与沙箱层对同一符号链接路径结论一致（均拒绝）');
      } finally { h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  // ══ S3 的**下游**：执行器不得把"结果未知"压成"失败" ═══════════════════════
  runner.test('S3/d 执行器必须把超时的两个轴透传给上层，不得压成普通 failed', async () => {
    // 沙箱修好了、执行器却没透传，等于白修：上层看到的仍是 `failed`，
    // 仍会据"执行了但没成"去重试一个可能已有副作用的操作。
    const d = tmp('s3d-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      // `tool-executor` 导出的是**冻结的单例**（`export default new ToolExecutor()`），
      // 不能直接改它的字段。沿用既有测试的做法：`Object.create(单例)` 造一个派生实例，
      // 这样打到的仍是**同一份真实代码**（原型链），只是状态独立。
      const D = await imp('src/core/core.js');
      const core = new D.Core({ stateDir: join(d, 'state') });
      core.log = () => {}; core.emitFast = () => {};
      core.registerService('sandbox', {
        execute: async () => ({
          ok: false, code: 'sandbox_timeout_indeterminate', error: 'Timeout: bash (75ms)',
          request_state: 'timed_out', execution_state: 'unknown_or_running',
          execution_may_continue: true, terminated_confirmed: false, request_id: 'sbx-9',
        }),
      });
      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      exec._useSandbox = true; exec.core = core;
      {
        const r = await exec._maybeSandbox('tool-bash', { command: 'sleep 5' },
          { name: 'tool-bash', sandboxOp: 'bash' });
        assertEquals(r.state, 'unknown',
          `超时必须是 unknown 而不是 failed（failed 会被上层当作"没成但无副作用"去重试），实际 ${r.state}`);
        assertEquals(r.request_state, 'timed_out', '必须透传 request_state');
        assertEquals(r.execution_state, 'unknown_or_running', '必须透传 execution_state');
        assertEquals(r.execution_may_continue, true, '必须透传"副作用可能还在发生"');
        assertEquals(r.terminated_confirmed, false, '不得透传成"已终止"');
        assertEquals(r.request_id, 'sbx-9', '必须透传可关联的 request_id');
        console.log('       [实测] 执行器透传：state=unknown / request_state=timed_out / '
          + 'execution_state=unknown_or_running / terminated_confirmed=false');
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('S3/e 普通沙箱拒绝仍必须是 failed（不得把所有拒绝都说成 unknown）', async () => {
    // 反向判据：修 S3 不能把边界拒绝也变成"结果未知"——那会让明确的拒绝失去可操作性。
    const d = tmp('s3e-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const D = await imp('src/core/core.js');
      const core = new D.Core({ stateDir: join(d, 'state') });
      core.log = () => {}; core.emitFast = () => {};
      core.registerService('sandbox', {
        execute: async () => ({ ok: false, code: 'sandbox_path_denied', error: 'Path denied', blocked: true }),
      });
      const exec = Object.create((await imp('plugins/tool-executor.js')).default);
      exec._preHooks = []; exec._postHooks = []; exec._dispatchHooks = [];
      exec._rateCalls = new Map(); exec._cache = new Map(); exec._auditLog = new Map();
      exec._useSandbox = true; exec.core = core;
      {
        const r = await exec._maybeSandbox('tool-write', { path: '/etc/x', content: 'y' },
          { name: 'tool-write', sandboxOp: 'write' });
        assertEquals(r.state, 'failed', `路径拒绝不应变成 unknown，实际 ${r.state}`);
        assertEquals(r.code, 'sandbox_path_denied', '必须透传具名 code');
        assertEquals(r.execution_may_continue, undefined, '路径拒绝不得声称"副作用可能还在发生"');
        console.log('       [实测] 路径拒绝仍是 failed（未被 S3 的改动污染）');
      }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  runner.test('X/2 拒绝必须是 failed-safe 的：任何具名拒绝都不得返回成功状态', async () => {
    const d = tmp('x2-');
    try {
      const ws = join(d, 'ws'); mkdirSync(ws);
      const h = await makeSandbox(d, { 'sandbox.deny': [ws], 'sandbox.bashAllowlist': ['echo'] });
      try {
        const cases = [
          ['write', { path: join(ws, 'a.txt'), content: 'x' }],
          ['read', { path: join(ws, 'a.txt') }],
          ['list', { path: ws }],
          ['stat', { path: join(ws, 'a.txt') }],
          ['bash', { command: 'echo ok' }],
          ['write', { path: '', content: 'x' }],
          ['eval', {}],
          ['nosuchop', {}],
        ];
        for (const [op, args] of cases) {
          const r = await h.S.execute(op, args);
          if (r.ok === true) {
            // 唯一允许成功的是"未知 op 由子进程报错"这条 —— 它必须也是 ok:false
            assert(false, `${op} ${JSON.stringify(args)} 不得返回 ok:true（code=${r.code}）`);
          }
          assertEquals(typeof r.error, 'string', `${op}: 失败必须带可读原因`);
        }
        console.log(`       [实测] ${cases.length} 类拒绝全部 ok:false 且带原因`);
      } finally { await h.S.killAll(); h.restore(); }
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
}

// 本文件沿用的最小断言约定（与 test/lib 一致），避免依赖具体 runner 的内部字段。
function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEquals failed'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assert failed');
}
