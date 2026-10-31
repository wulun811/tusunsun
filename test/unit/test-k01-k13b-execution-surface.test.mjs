// v0.12.0 内核精修 P1：执行切面（K-01 / K-02 / K-06 / K-07 / K-08 / K-13b）
//
// 这六条不是"代码风格问题"，每一条都能在旧版上复现出**用户的真实损失**：
//   · K-02 超时归零 → 热重载在 handler 仍在跑时"安全成功"，留下半截副作用；
//   · K-07 schema 根类型 → 声明了 required 的能力被 null 调穿，副作用照落；
//   · K-06 override 丢 schema → 同一条判据、同一种形状，v0.9.32 只修了 permissions 一列；
//   · K-01 无 TTY 自动同意 → CI 里系统替人点头；
//   · K-08 监听器泄漏 → 长驻进程无界增长；
//   · K-13b 匿名让渡 → 一个不署名的调用能删掉别人的能力。
//
// 本文件与 `test/probes/k01-k14-core-semantics.mjs` 的分工：
//   · 探针：可独立运行、给人核对、打印 BUG/FIXED；
//   · 本文件：走 harness、跟 CI 跑、断言细，并在会退化时立刻变红。
//
// 关于判据层次的教训（v0.10.4 记录过、v0.11.0 又验证过一次）：
// **行为判据证明不了是哪一层在拦**。所以这里的每一条都尽量同时给
// ① 端到端行为（真的发生了什么）与 ② 结构判据（源码里那个事实的写入点）。
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  let tmp;

  runner.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'p1-exec-'));
    mkdirSync(join(tmp, 'plugins'), { recursive: true });
  });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });

  const makeCore = () => new Core({ stateDir: tmp, pluginsDir: join(tmp, 'plugins') });

  // ── K-02：唯一执行结算点 ────────────────────────────────────────────────
  runner.test('K-02/1 command 超时后 handler 仍在跑：getInflight 必须仍 > 0', async () => {
    const core = makeCore();
    let finished = false;
    core.registerCapability('slow.cap', {
      handler: async () => { await new Promise((r) => setTimeout(r, 140)); finished = true; return 'done'; },
    });
    const r = await core.command('slow.cap', {}, 15);
    assertEquals(r.state, 'failed', '超时应归 failed');
    assertEquals(r.code, 'timeout_no_abort', 'code 必须是 timeout_no_abort（不得冒充 cancelled）');
    // 这是核心断言：返回瞬间 handler 确定还在跑，计数就不能是 0。
    assertEquals(finished, false, '前提：此刻 handler 应仍在跑');
    assertEquals(core.getInflight('unknown') > 0, true,
      `超时返回时 in-flight 必须仍 > 0（实际 ${core.getInflight('unknown')}）—— `
      + '修前 Promise.race 的 finally 把它减到 0，导致 reload 闸门以为可安全替换');
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(core.getInflight('unknown'), 0, 'handler 真正 settle 后才归零');
    core.removeAllListeners();
  });

  runner.test('K-02/2 超时信封带加性字段，且旧三态语义不变', async () => {
    const core = makeCore();
    core.registerCapability('slow.cap', { handler: async () => { await new Promise((r) => setTimeout(r, 120)); return 1; } });
    const r = await core.command('slow.cap', {}, 10);
    assertEquals(r.ok, false, 'ok 仍为 false');
    assertEquals(r.payload, null, '失败 payload 必须为 null（R0-76 不变式）');
    assertEquals(r.execution_outcome, 'unknown', '必须具名"效果未知"');
    assertEquals(r.still_running_at_return, true, '必须具名"返回时仍在运行"');
    core.removeAllListeners();
  });

  runner.test('K-02/3 callCapability 与 command 走同一条结算（结构判据）', async () => {
    const src = readFileSync(join(ROOT, 'src', 'core', 'core.js'), 'utf8');
    // 全仓 `_inflight.set` 只允许两处：一处 +1（登记）、一处写回减计数后的值。
    // 修前是 4 处（callCapability 与 command 各一对），那正是"两套结算"的指纹。
    const sets = src.split('\n').filter((l) => l.includes('_inflight.set('));
    assertEquals(sets.length, 2,
      `_inflight.set 只允许 2 处（+1 与写回），实际 ${sets.length} 处 —— `
      + '两条入口各写一套就会再次漂移（修前是 4 处）');
    assert(/_dispatchCapability\s*\(/.test(src), '_dispatchCapability 必须在场（唯一的执行结算点）');
  });

  // ── K-07：schema 根类型 ────────────────────────────────────────────────
  runner.test('K-07/1 声明了结构化契约的能力，params=null/字符串/数组必须被拒且零副作用', async () => {
    const core = makeCore();
    let ran = 0;
    core.registerCapability('y.cap', {
      handler: () => { ran++; return 'ran'; },
      input_schema: { required: ['a'], properties: { a: { type: 'string' } } },
    });
    for (const bad of [null, 'not-an-object', [1, 2], 42]) {
      const r = await core.callCapability('y.cap', bad);
      assertEquals(r.ok, false, `params=${JSON.stringify(bad)} 必须被拒`);
      assertEquals(r.code, 'invalid_input', '必须归 invalid_input（不是运行失败）');
    }
    assertEquals(ran, 0, '被拒的调用**一次都不能**执行 handler');
    core.removeAllListeners();
  });

  runner.test('K-07/2 合法非对象参数的能力不受影响（不能一刀切）', async () => {
    const core = makeCore();
    // 没有声明结构化契约 ⇒ 接受任意参数（既有行为，不能因为 K-07 改变）
    core.registerCapability('free.form', { handler: (p) => ({ got: p }) });
    const r1 = await core.callCapability('free.form', 'plain-string');
    assertEquals(r1.ok, true, '未声明结构化契约的能力应接受字符串参数');
    assertEquals(r1.payload.got, 'plain-string', '参数应原样传入');
    core.removeAllListeners();
  });

  // ── K-06：override 全字段继承 ─────────────────────────────────────────
  runner.test('K-06/1 同 owner override 省略 input_schema 必须继承旧约束', async () => {
    const core = makeCore();
    const h = core.registerCapability('x.cap', {
      owner: 'o', handler: () => 1,
      input_schema: { required: ['a'], properties: { a: { type: 'string' } } },
      permissions: { require_identity: true },
      tags: ['t1'],
    });
    core.registerCapability('x.cap', { owner: 'o', handler: () => 2, overrideBy: h });
    const rec = core._capabilities.get('x.cap');
    assert(rec.input_schema !== undefined, 'input_schema 不得丢失（修前实测为 undefined）');
    assertEquals(JSON.stringify(rec.input_schema.required), '["a"]', 'required 必须继承');
    assertEquals(rec.permissions?.require_identity, true, 'permissions 必须继承（R0-151 已有的那列）');
    assertEquals(JSON.stringify(rec.tags), '["t1"]', 'tags 也必须继承（同一条判据）');
    core.removeAllListeners();
  });

  runner.test('K-06/2 显式声明（含 null）才是覆盖，省略是继承', async () => {
    const core = makeCore();
    const h = core.registerCapability('x.cap', { owner: 'o', handler: () => 1, input_schema: { required: ['a'] } });
    core.registerCapability('x.cap', { owner: 'o', handler: () => 2, overrideBy: h, input_schema: null });
    assertEquals(core._capabilities.get('x.cap').input_schema, null, '显式 null 表示"清空"，必须生效');
    core.removeAllListeners();
  });

  // ── K-01：无人在场不得替人点头 ────────────────────────────────────────
  runner.test('K-01/1 无 TTY + 要求确认 + 无可信授权 ⇒ 必须拒绝', async () => {
    const core = makeCore();
    core._services.set('config', {
      get: (k, d) => (k === 'privacy.requireConfirmFor' ? ['delete'] : d),
      set() {},
    });
    const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let approved;
    let reason = null;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      core.on('core.confirm', (e) => { reason = e.reason; });
      approved = await core.confirm('删除 /tmp/x（不可撤销）', 40);
    } finally {
      if (saved) Object.defineProperty(process.stdin, 'isTTY', saved); else delete process.stdin.isTTY;
    }
    assertEquals(approved, false, '修前返回 true（Non-TTY auto-approved）—— 系统替人做了同意的决定');
    assertEquals(reason, 'no_tty_refused', '事件必须具名理由，便于上层区分"用户拒绝"与"无人在场"');
    core.removeAllListeners();
  });

  runner.test('K-01/2 宿主显式 trustedAutoApprove 时可放行，且留证据', async () => {
    const core = makeCore();
    core._services.set('config', {
      get: (k, d) => {
        if (k === 'privacy.requireConfirmFor') return ['delete'];
        if (k === 'privacy.trustedAutoApprove') return true;
        return d;
      },
      set() {},
    });
    const saved = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    let reason = null;
    let approved;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
      core.on('core.confirm', (e) => { reason = e.reason; });
      approved = await core.confirm('删除 /tmp/x', 40);
    } finally {
      if (saved) Object.defineProperty(process.stdin, 'isTTY', saved); else delete process.stdin.isTTY;
    }
    assertEquals(approved, true, '显式授权时必须放行（否则无头环境无法做任何事）');
    assertEquals(reason, 'trusted_auto_approved', '放行必须留证据，不能与"用户同意"混为一谈');
    core.removeAllListeners();
  });

  // ── K-08：事件式 command 的监听器 ─────────────────────────────────────
  runner.test('K-08/1 反复超时不得遗留 .response / .error 监听器', async () => {
    const core = makeCore();
    // 事件名必须含 "."（emit 有格式校验），否则连 emit 都被拒绝，会误判成"无泄漏"
    const before = { r: core.listenerCount('ghost.work.response'), e: core.listenerCount('ghost.work.error') };
    for (let i = 0; i < 5; i++) await core.command('ghost.work', {}, 5);
    const after = { r: core.listenerCount('ghost.work.response'), e: core.listenerCount('ghost.work.error') };
    assertEquals(after.r - before.r, 0, `.response 不得增长（增 ${after.r - before.r}）`);
    assertEquals(after.e - before.e, 0, `.error 不得增长（修前每次超时增 1，实测 5 次增 5）`);
    core.removeAllListeners();
  });

  runner.test('K-08/2 响应与错误两条路径也各清两个监听器', async () => {
    const core = makeCore();
    const before = core.listenerCount('evt.ok.response') + core.listenerCount('evt.ok.error');
    const p = core.command('evt.ok', { x: 1 }, 1000);
    core.emit('evt.ok.response', { ok: true, payload: { v: 1 } });
    await p;
    assertEquals(core.listenerCount('evt.ok.response') + core.listenerCount('evt.ok.error'), before,
      '响应路径必须清掉两个监听器');
    core.removeAllListeners();
  });

  // ── K-13b：匿名让渡 ───────────────────────────────────────────────────
  runner.test('K-13b/1 releaseCapability 只认凭据：owner 字符串（含省略）一律具名拒绝', async () => {
    const core = makeCore();
    core.registerCapability('z.cap', { owner: 'A', handler: () => 1 });
    for (const cred of [undefined, 'A', 'zzz']) {
      let code = null;
      try { core.releaseCapability('z.cap', cred); } catch (e) { code = e.code; }
      assertEquals(code, 'capability_release_denied', `凭据 ${String(cred)} 不得释放`);
    }
    assertEquals(core._capabilities.has('z.cap'), true, '能力必须仍在');
    core.removeAllListeners();
  });

  runner.test('K-13b/2 持凭据的主人仍可让渡（不能把路堵死）', async () => {
    const core = makeCore();
    const h = core.registerCapability('z.cap', { owner: 'A', handler: () => 1 });
    assertEquals(core.releaseRegistration(h), true, '持凭据的让渡必须成功');
    assertEquals(core._capabilities.has('z.cap'), false, '让渡后能力应消失');
    core.removeAllListeners();
  });

  runner.test('K-13b/3 无主能力同样按凭据撤销（不再有“谁都能删”的分支）', async () => {
    const core = makeCore();
    const h = core.registerCapability('free.cap', { handler: () => 1 });
    let code = null;
    try { core.releaseCapability('free.cap'); } catch (e) { code = e.code; }
    assertEquals(code, 'capability_release_denied', '无主不等于无主可删');
    assertEquals(core._capabilities.has('free.cap'), true);
    assertEquals(core.releaseRegistration(h), true);
    assertEquals(core._capabilities.has('free.cap'), false);
    core.removeAllListeners();
  });
}
