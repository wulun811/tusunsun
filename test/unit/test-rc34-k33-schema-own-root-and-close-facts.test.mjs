// rc.34 —— 专家 rc.33 源码级复审（K33-A / K33-B）给出的四条反例的一次性判据。
//
// 这一批与前两批（R31 / R32）错的地方不一样：前两批是**判据取错了主语**，这一批是
// **声明了却没人执行**，以及**事件早于事实**。
//
//   K33-A1  合同写「required 是必填」「properties 按 type 校验」，运行期却用 `params[k]` 读 ——
//           读的是原型链。`{}` 的 `__proto__` 是继承来的那个对象，于是「根本没给这个字段」
//           被读成「给了，而且正好是 object」，handler 照跑。
//   K33-A2  支持表把根 `type` 列进去，`_schemaViolation` 却只在 required/properties 存在时
//           才要求 object；其余根类型**声明了不执行**：`{type:'object'}` 传 'str' 放行。
//   K33-B   返回 `closed:true` 并发 `cell.closed` 的判据是「执行资格撤销了吗」，而它该回答的
//           是「清理做完了吗」。在飞强制关闭时这两件事不同：锁还在、工作区没解绑，
//           外部却已经收到「已关闭」。
//
// 边界（诚实）：
//   · 全部进程内直测（真 Core / 真 workspace / 真 cell-runtime / 真 tool-executor / 真写盘）；
//   · A 组反例是**公开 API 可达**的（registerCapability + callCapability），不需要任何特权；
//   · B 组的在飞异步链由测试自己安排（受信任的同进程组件），**不**声称模型能安排自己的
//     异步回调，也不声称这里是 OS 级隔离。
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const tmp = (tag) => mkdtempSync(join(tmpdir(), `rc34-${tag}-`));
const lockDir = (base) => join(base, 'state', 'cells', 'owner.lock');

const spec = (id, workspace) => ({
  schema_version: 'tusunsun.cell/v0',
  cell_id: id,
  workspace,
  capabilities: ['tool.read', 'tool.write'],
  permission_mode: 'auto',
  runtime: { kind: 'process' },
  limits: { max_active_tasks: 1, max_children: 0 },
});

const taskOf = (id, cellId = 'c1') => ({
  schema_version: 'tusunsun.task/v0',
  task_id: id,
  attempt: 1,
  target_cell_id: cellId,
  goal: `goal ${id}`,
  inputs: [],
  required_capabilities: ['tool.read'],
  budget: { max_steps: 5, wall_ms: 30000 },
  acceptance: { required_artifacts: [], checks: [] },
});

/** 只要 registerCapability/callCapability 的干净 Core（A 组用）。 */
async function bareCore(base) {
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  return core;
}

let seq = 0;
/**
 * 注册一条带 input_schema 的能力并调用它，返回 `{ok, code, error, calls}`。
 * `calls` 是**事实**：拒绝时必须是 0，不能只看返回码。
 */
async function callWith(core, schema, params) {
  let calls = 0;
  const id = `k33.case${++seq}`;
  core.registerCapability(id, {
    owner: 'test',
    handler: async () => { calls++; return 'ran'; },
    input_schema: schema,
  });
  const r = await core.callCapability(id, params);
  return { ok: r?.ok === true, code: r?.code ?? null, error: r?.error ?? '', calls };
}

/** 真装配：一个 Core + workspace + tool-executor + cell-runtime，外加事件计数。 */
async function host(base, { chat } = {}) {
  const { Core } = await imp('src/core/core.js');
  const wsDir = join(base, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const core = new Core({ stateDir: join(base, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', wsDir);
  await (await imp('plugins/workspace.js')).default.init(core);
  core.registerCapability('tool.read', { owner: 'test', handler: async () => ({ ok: true }) });
  core.registerCapability('tool.write', { owner: 'test', handler: async () => ({ ok: true }) });
  core.registerCapability('chat.handle', { owner: 'test', handler: chat || (async () => ({ reply: 'ok' })) });
  const Cls = (await imp('plugins/tool-executor.js')).default.constructor;
  await new Cls().init(core);
  const rt = (await imp('plugins/cell-runtime.js')).default;
  await rt.init(core);
  const events = { closed: 0, closing: 0, closedPayloads: [], closingPayloads: [] };
  core.on('cell.closed', (x) => { events.closed++; events.closedPayloads.push(x); });
  core.on('cell.closing', (x) => { events.closing++; events.closingPayloads.push(x); });
  return {
    core,
    wsDir,
    events,
    svc: core.getService('cell-runtime'),
    create: (over = {}) => core.getService('cell-runtime').create(spec('c1', wsDir, over), { trusted: true }),
  };
}

export default async function (runner) {
  // ═══════════════════════════════════════════════════════════════════
  // K33-A1：必填/类型判据只能看 **own** 属性
  // ═══════════════════════════════════════════════════════════════════

  runner.test('K33-A1/1 required 同名键落在原型链上不算「已提供」（__proto__）', async () => {
    const base = tmp('a1');
    try {
      const core = await bareCore(base);
      // 用 JSON.parse 造**真实 own 键**的 properties —— 与专家原件同一构造。
      const schema = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"object"}}}');
      const r = await callWith(core, schema, {});
      assertEquals(r.ok, false, 'params={} 的 __proto__ 是继承来的对象，不能当成「给了这个字段」');
      assertEquals(r.code, 'invalid_input', `应 invalid_input，实际 ${r.code}`);
      assertEquals(r.calls, 0, '拒绝必须先于派发：handler 一次都不能跑');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/2 own 的 __proto__ 且类型合规必须能调用（正例，不许「拒绝一切」冒充修复）', async () => {
    const base = tmp('a1b');
    try {
      const core = await bareCore(base);
      const schema = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"object"}}}');
      const params = JSON.parse('{"__proto__":{}}');
      assert(Object.hasOwn(params, '__proto__'), '构造前提：JSON.parse 造出的是 own 键');
      const r = await callWith(core, schema, params);
      assertEquals(r.ok, true, `合法 own 键必须放行，实际 ${r.code}: ${r.error}`);
      assertEquals(r.calls, 1, '合法调用必须真的执行一次');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/3 constructor / toString 同上：继承的不算，own 的按类型判', async () => {
    const base = tmp('a1c');
    try {
      const core = await bareCore(base);
      const schema = {
        type: 'object',
        required: ['constructor', 'toString'],
        properties: { constructor: { type: 'object' }, toString: { type: 'string' } },
      };
      const miss = await callWith(core, schema, {});
      assertEquals(miss.ok, false, '{} 上 constructor/toString 都是继承来的函数，不是「已提供」');
      assert(miss.error.includes('缺少必填参数'), `拒因必须是「没有这个 own 属性」，实际：${miss.error}`);
      assertEquals(miss.calls, 0, '拒绝时零派发');
      const wrong = await callWith(core, schema, { constructor: {}, toString: 123 });
      assertEquals(wrong.ok, false, 'own 但类型不对必须拒');
      assertEquals(wrong.calls, 0, '类型不对时零派发');
      const good = await callWith(core, schema, { constructor: {}, toString: 'x' });
      assertEquals(good.ok, true, `合法 own 值必须放行，实际 ${good.code}: ${good.error}`);
      assertEquals(good.calls, 1, '合法调用必须真的执行一次');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/4 own 属性存在但值是 undefined ≠ 已提供（JSON 没有 undefined）', async () => {
    const base = tmp('a1d');
    try {
      const core = await bareCore(base);
      const schema = { type: 'object', required: ['a'], properties: { a: { type: 'string' } } };
      const r = await callWith(core, schema, { a: undefined });
      assertEquals(r.ok, false, 'own + undefined 不是「给了字符串」');
      assertEquals(r.calls, 0, '拒绝时零派发');
      assert(r.error.includes('undefined'), `拒绝理由要指出是 undefined，实际：${r.error}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/5 访问器参数一律拒（读它等于让输入自己决定校验结果）', async () => {
    const base = tmp('a1e');
    try {
      const core = await bareCore(base);
      const schema = { type: 'object', properties: { a: { type: 'string' } } };
      const params = {};
      Object.defineProperty(params, 'a', { get: () => 'x', enumerable: true, configurable: true });
      const r = await callWith(core, schema, params);
      assertEquals(r.ok, false, 'getter 每次读可以给不同答案，不能进准入判据');
      assertEquals(r.calls, 0, '拒绝时零派发');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/6 非纯数据根对象（类实例）被拒，Object.create(null) 照常放行', async () => {
    const base = tmp('a1f');
    try {
      const core = await bareCore(base);
      class Box { constructor() { this.a = 'x'; } }
      const schema = { type: 'object', properties: { a: { type: 'string' } } };
      const inst = await callWith(core, schema, new Box());
      assertEquals(inst.ok, false, '类实例的原型上有别人能改的读数，不进准入判据');
      assertEquals(inst.calls, 0, '拒绝时零派发');
      const dict = Object.create(null);
      dict.a = 'x';
      const nullProto = await callWith(core, schema, dict);
      assertEquals(nullProto.ok, true, `无原型字典是纯数据，必须放行，实际 ${nullProto.code}: ${nullProto.error}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A1/7 未提供的可选属性不校验、已提供的 own 属性必须按类型校验', async () => {
    const base = tmp('a1g');
    try {
      const core = await bareCore(base);
      const schema = { type: 'object', properties: { a: { type: 'string' }, n: { type: 'integer' } } };
      const absent = await callWith(core, schema, {});
      assertEquals(absent.ok, true, '没有 required 的声明里，缺省属性是合法的');
      assertEquals(absent.calls, 1, '合法调用必须真的执行一次');
      const badType = await callWith(core, schema, { a: 1 });
      assertEquals(badType.ok, false, '给了 own 的属性就必须合类型');
      assertEquals(badType.calls, 0, '类型不对时零派发');
      const nonInt = await callWith(core, schema, { n: 1.5 });
      assertEquals(nonInt.ok, false, 'integer 仍要 Number.isInteger 严格判');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  // ═══════════════════════════════════════════════════════════════════
  // K33-A2：根 type 声明了就必须执行
  // ═══════════════════════════════════════════════════════════════════

  runner.test('K33-A2/1 根 type:object 对 string/null/array/number 全部拒绝', async () => {
    const base = tmp('a2');
    try {
      const core = await bareCore(base);
      for (const [label, params] of [['string', 'str'], ['null', null], ['array', []], ['number', 42]]) {
        const r = await callWith(core, { type: 'object' }, params);
        assertEquals(r.ok, false, `{type:'object'} 传 ${label} 必须拒`);
        assertEquals(r.calls, 0, `${label}：拒绝时零派发`);
      }
      const good = await callWith(core, { type: 'object' }, { any: 1 });
      assertEquals(good.ok, true, `合法对象必须放行，实际 ${good.code}: ${good.error}`);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A2/2 根 type:string 传对象被拒、传字符串放行', async () => {
    const base = tmp('a2b');
    try {
      const core = await bareCore(base);
      const bad = await callWith(core, { type: 'string' }, { unexpected: 'object' });
      assertEquals(bad.ok, false, "{type:'string'} 传对象必须拒（专家原件就是这条放行）");
      assertEquals(bad.calls, 0, '拒绝时零派发');
      const good = await callWith(core, { type: 'string' }, 'hello');
      assertEquals(good.ok, true, `根标量的正例必须能调用，实际 ${good.code}: ${good.error}`);
      assertEquals(good.calls, 1, '合法调用必须真的执行一次');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A2/3 根 type:integer / boolean 同样执行', async () => {
    const base = tmp('a2c');
    try {
      const core = await bareCore(base);
      const nonInt = await callWith(core, { type: 'integer' }, 1.5);
      assertEquals(nonInt.ok, false, 'integer 根上的 1.5 必须拒');
      const int = await callWith(core, { type: 'integer' }, 3);
      assertEquals(int.ok, true, `整数根必须放行，实际 ${int.code}: ${int.error}`);
      const num = await callWith(core, { type: 'number' }, 1.5);
      assertEquals(num.ok, true, 'number 根接受 1.5');
      const boolBad = await callWith(core, { type: 'boolean' }, 'true');
      assertEquals(boolBad.ok, false, "boolean 根不接受字符串 'true'");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A2/4 没声明根 type、也没有属性契约时，任何参数照旧放行（不校验不等于全拒）', async () => {
    const base = tmp('a2d');
    try {
      const core = await bareCore(base);
      for (const [label, params] of [['42', 42], ['string', 'x'], ['null', null], ['object', {}]]) {
        const r = await callWith(core, {}, params);
        assertEquals(r.ok, true, `未声明约束时 ${label} 必须放行，实际 ${r.code}: ${r.error}`);
        assertEquals(r.calls, 1, `未声明约束时 ${label} 必须真的执行`);
      }
      const none = await callWith(core, undefined, undefined);
      assertEquals(none.ok, true, '完全没有 input_schema 的能力不受影响');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A2/5 结构化契约的既有正反例不回归（required+properties）', async () => {
    const base = tmp('a2e');
    try {
      const core = await bareCore(base);
      const schema = { type: 'object', required: ['path'], properties: { path: { type: 'string' }, limit: { type: 'integer' } } };
      const ok = await callWith(core, schema, { path: '/tmp/x', limit: 10 });
      assertEquals(ok.ok, true, `合法结构化入参必须放行，实际 ${ok.code}: ${ok.error}`);
      const missing = await callWith(core, schema, { limit: 10 });
      assertEquals(missing.ok, false, '缺必填必须拒');
      const wrongRoot = await callWith(core, schema, 'str');
      assertEquals(wrongRoot.ok, false, '根不是对象必须拒');
      const wrongType = await callWith(core, schema, { path: 1 });
      assertEquals(wrongType.ok, false, '属性类型不对必须拒');
      assertEquals(missing.calls + wrongRoot.calls + wrongType.calls, 0, '三条拒绝都必须零派发');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-A3 结构锁：准入判据里不得再用 params[k] 这种原型链读法', async () => {
    const src = readFileSync(join(ROOT, 'src/core/core.js'), 'utf8');
    const start = src.indexOf('_schemaViolation(s, params)');
    assert(start > 0, '必须还能找到 _schemaViolation');
    const body = src.slice(start, src.indexOf('\n  }', start));
    assert(!/\bparams\[k\]/.test(body), '_schemaViolation 里出现 params[k] 就是原型链读法回来了');
    assert(body.includes('Object.getOwnPropertyDescriptor') || body.includes('Object.hasOwn'),
      '必须用 own 属性判据（getOwnPropertyDescriptor / hasOwn）');
  });

  // ═══════════════════════════════════════════════════════════════════
  // K33-B：撤销 / 清理中 / 清理完成 三个事实各有各的返回与事件
  // ═══════════════════════════════════════════════════════════════════

  runner.test('K33-B/1 在飞强制关闭只能报「清理中」：closed:false + cell.closing + 锁留着', async () => {
    const base = tmp('b1');
    let release = () => {};
    let began = () => {};
    const gate = new Promise((r) => { release = r; });
    const started = new Promise((r) => { began = r; });
    const h = await host(base, { chat: async () => { began(); await gate; return { reply: 'done' }; } });
    try {
      await h.create();
      h.svc.accept('c1', taskOf('A'));
      const executing = h.svc.execute('c1');
      await started;
      const closed = await h.svc.close('c1', { force: true, quiesceMs: 20 });
      assertEquals(closed.execution_revoked, true, '执行资格必须立刻撤销（这条 rc.33 已经做对）');
      assertEquals(h.svc.describe('c1').state, 'stopped', '对外状态必须立刻是 stopped');
      assertEquals(closed.closed, false, '清理没做完就不能回 closed:true —— 这正是 K33-B');
      assertEquals(closed.closing, true, '必须给出「清理中」这个专用事实');
      assertEquals(closed.cleanup_done, false, '清理未完成');
      assert(Array.isArray(closed.cleanup_pending) && closed.cleanup_pending.length > 0,
        `必须列出还没做完的清理项，实际 ${JSON.stringify(closed.cleanup_pending)}`);
      assertEquals(h.events.closed, 0, '清理没做完就发 cell.closed = 把「撤销」当成「关完了」');
      assertEquals(h.events.closing, 1, '必须发且只发一次 cell.closing');
      assert(existsSync(lockDir(base)), '旧链还在跑，属主锁必须留着');
      release();
      await executing.catch(() => {});
      const retried = await h.svc.close('c1', { force: true, quiesceMs: 5000 });
      assertEquals(retried.closed, true, `重试必须能真正关完，实际 ${JSON.stringify(retried)}`);
      assertEquals(retried.cleanup_done, true, '重试后清理完成');
      assertEquals(retried.cleanup_pending?.length, 0, '重试后没有待办');
      assertEquals(h.events.closed, 1, 'cell.closed 只在清理真正完成时发，且只发一次');
      assertEquals(existsSync(lockDir(base)), false, '关完之后锁必须真的被删掉');
    } finally {
      release();
      rmSync(base, { recursive: true, force: true });
    }
  });

  runner.test('K33-B/2 干净关闭：closed:true + cleanup_done:true + 只发 cell.closed', async () => {
    const base = tmp('b2');
    const h = await host(base);
    try {
      await h.create();
      const closed = await h.svc.close('c1', {});
      assertEquals(closed.closed, true, '没有在飞链时关闭必须真的关完');
      assertEquals(closed.cleanup_done, true, '干净关闭的 cleanup_done 必须是 true');
      assertEquals(closed.cleanup_pending?.length, 0, '干净关闭没有待办');
      assertEquals(h.events.closed, 1, '必须发一次 cell.closed');
      assertEquals(h.events.closing, 0, '干净关闭不该发 cell.closing');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-B/3 已关完之后再 close：already:true，且不重复发 cell.closed', async () => {
    const base = tmp('b3');
    const h = await host(base);
    try {
      await h.create();
      await h.svc.close('c1', {});
      const again = await h.svc.close('c1', {});
      assertEquals(again.already, true, '第二次必须是 already');
      assertEquals(again.closed, true, 'already 的前提就是已经关完');
      assertEquals(h.events.closed, 1, '不得因为重复 close 再发一次 cell.closed');
      assertEquals(h.events.closing, 0, '也不该补发 cell.closing');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  runner.test('K33-B/4 closed 字段与 cleanup_done 同源：两者不可能给出不同答案', async () => {
    const base = tmp('b4');
    const h = await host(base);
    try {
      await h.create();
      const closed = await h.svc.close('c1', {});
      assertEquals(closed.closed, closed.cleanup_done, 'closed 必须等价于 cleanup_done');
      const again = await h.svc.close('c1', {});
      assertEquals(again.closed, true, 'already 路径同样只在清理完成时成立');
      assertEquals(again.cleanup_done, true, 'already 路径必须带上 cleanup_done:true');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  return runner;
}
