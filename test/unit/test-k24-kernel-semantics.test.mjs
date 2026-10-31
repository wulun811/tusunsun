/**
 * K24：内核语义去重与状态闭合。
 *
 * 对应专家《土行孙 rc.23｜K24 内核瘦身与语义去重专项审查》§2 的五个实证缺陷。
 * 每项都是**先复现后修**（修前红灯、修后绿灯），并配对称正控：
 *   K24-01 一次真实 running 转移只能有一条 `core:plugin.loaded` 事实
 *   K24-02 普通卸载也要发 `core:plugin.unloaded`；"回收"是**另一个**事实
 *   K24-03 合法共享引用不得被当成环降级（降级的副作用是观察者能改到事实源）
 *   K24-04 `provides` 反查索引的建账/撤账必须同一份规范化（对象、通配符）
 *   K24-05 回收**未释放**时不得先抹掉"仍被装载"的记录
 *
 * 注入点说明：K24-02 的 `stop_timeout` / `drain_timeout` 用**符合卸载合同**的返回形状做单元
 * 故障注入，不冒充真实 5 秒卡死的系统实测；真实 stop 抛出、真实卸载、真实装载都走真实现。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

const pluginSrc = (name, extra = '') => `
export default {
  name: '${name}',
  version: '0.0.1',
  provides: [],
  async init() {},
  async stop() {},
${extra}
};
`;

export async function setup(runner) {
  const { Core } = await imp('src/core/core.js');
  const { PluginManager } = await imp('src/core/plugin-manager.js');
  const dirs = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'k24-')); dirs.push(d); return d; };

  const makeCore = (dir) => {
    const core = new Core({ stateDir: dir });
    core.log = () => {};
    core.running = true;
    core._epoch = 1;
    core._stopAssemblyDrainMs = 20;
    return core;
  };
  /** 真的写到盘上、真的 `import`：不 mock 插件模块。 */
  const pluginFile = (dir, name, extra) => {
    const f = join(dir, `${name}.mjs`);
    writeFileSync(f, pluginSrc(name, extra));
    return f;
  };
  const freshPM = (dir) => {
    const core = makeCore(dir);
    const pm = new PluginManager(core);
    pm.dirs = [dir];
    return { core, pm };
  };

  // ═══════════════════════════════════════════════════════════════
  // K24-01 —— 装载事实只有一个发布者
  // ═══════════════════════════════════════════════════════════════
  runner.test('K24-01/1 懒加载：一次真实 running 转移只有一条 loaded 事实', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    const file = pluginFile(d, 'k24-lazy');
    pm._pending.set('k24-lazy', { filePath: file, requires: {}, provides: [], source: 'test' });
    const loaded = [];
    core.on('core:plugin.loaded', (v) => loaded.push(v));
    await pm._lazyLoadOne('k24-lazy');

    assertEquals(loaded.length, 1, `一次装载只能发一条事实，实际 ${JSON.stringify(loaded)}`);
    assertEquals(loaded[0].pluginName, 'k24-lazy', 'canon 字段是 pluginName');
    assertEquals(loaded[0].name, 'k24-lazy', '兼容别名 name 必须保留（历史消费者读它）');
    assertEquals(loaded[0].sourcePlugin, 'lifecycle-manager', '发布点必须是生命周期提交点，不是 PluginManager');
  });

  runner.test('K24-01/2 走 loadOne（非懒加载路径）同样只有一条', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-eager');
    const loaded = [];
    core.on('core:plugin.loaded', (v) => loaded.push(v));
    const r = await pm.loadOne('k24-eager');
    assertEquals(r.ok, true, '前提：装载成功');
    assertEquals(loaded.length, 1);
    assertEquals(loaded[0].pluginName, 'k24-eager');
  });

  runner.test('K24-01/3 init 失败不得产生成功事实', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-bad', "  async init() { throw new Error('k24-init-boom'); },");
    const loaded = [];
    core.on('core:plugin.loaded', (v) => loaded.push(v));
    const r = await pm.loadOne('k24-bad');
    assertEquals(r.ok, false, '前提：装载失败');
    assertEquals(loaded.length, 0, '失败不得产生已提交事实');
  });

  runner.test('K24-01/4 观察者抛错不改变装载结论，也不复制事实', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-observer-boom');
    let delivered = 0;
    core.on('core:plugin.loaded', () => { delivered++; throw new Error('observer-boom'); });
    const r = await pm.loadOne('k24-observer-boom');
    assertEquals(r.ok, true, '观察者抛错不得把装载报成失败');
    assertEquals(delivered, 1);
    assert(core.getObserverErrors().length >= 1, '错误必须进诊断面，不静默吞掉');
  });

  // ═══════════════════════════════════════════════════════════════
  // K24-02 —— 卸载事实与回收事实分开，两侧对称
  // ═══════════════════════════════════════════════════════════════
  runner.test('K24-02/1 普通卸载成功：一条 unloaded，字段说清“已释放、结局已知”', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-unload');
    await pm.loadOne('k24-unload');
    const unloaded = [];
    core.on('core:plugin.unloaded', (v) => unloaded.push(v));

    const r = await pm.unload('k24-unload');
    assertEquals(r.ok, true, '前提：卸载成功');
    assertEquals(unloaded.length, 1, `普通卸载也必须发事实，实际 ${unloaded.length}`);
    assertEquals(unloaded[0].pluginName, 'k24-unload');
    assertEquals(unloaded[0].released, true);
    assertEquals(unloaded[0].execution_outcome, 'known');
    assertEquals(unloaded[0].sourcePlugin, 'lifecycle-manager');
  });

  runner.test('K24-02/2 stop 卡死（released:false）不得产生已卸载事实，也不得清账本', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-stuck');
    await pm.loadOne('k24-stuck');
    pm._lazyLoaded.add('k24-stuck');
    pm._lastAccess.set('k24-stuck', 1);
    const unloaded = [];
    core.on('core:plugin.unloaded', (v) => unloaded.push(v));
    // 符合卸载合同的真实返回形状（不冒充真实 5 秒超时）。
    pm.lc.unload = async () => ({ ok: false, code: 'stop_timeout', released: false, forced_partial: false });

    const r = await pm.unload('k24-stuck');
    assertEquals(r.ok, false);
    assertEquals(unloaded.length, 0, 'released:false 绝不能被读成已卸载');
    assertEquals(pm._lazyLoaded.has('k24-stuck'), true, '它可能还在跑：不得抹掉“仍被装载”');
  });

  runner.test('K24-02/3 stop 抛出：卸载照常提交，但事实带 stop_failed（不抹平失败）', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pluginFile(d, 'k24-stop-throws', "  async stop() { throw new Error('k24-stop-boom'); },");
    await pm.loadOne('k24-stop-throws');
    const unloaded = [];
    core.on('core:plugin.unloaded', (v) => unloaded.push(v));
    await pm.unload('k24-stop-throws');
    assertEquals(unloaded.length, 1, '三条终局分支共用同一发布点');
    assertEquals(unloaded[0].stop_failed, true, 'stop 抛过就必须在事实里看得见');
    assertEquals(unloaded[0].released, true);
  });

  runner.test('K24-02/4 回收 = 卸载事实 + 回收事实各一条，不得重复宣告卸载', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    const file = pluginFile(d, 'k24-recycle');
    pm._pending.set('k24-recycle', { filePath: file, requires: {}, provides: [], source: 'test' });
    await pm._lazyLoadOne('k24-recycle');
    pm._pending.set('k24-recycle', { filePath: file, requires: {}, provides: [], source: 'test' });
    const unloaded = [];
    const recycled = [];
    core.on('core:plugin.unloaded', (v) => unloaded.push(v));
    core.on('core:plugin.recycled', (v) => recycled.push(v));

    await pm._recycle('k24-recycle');
    assertEquals(unloaded.length, 1, `卸载事实只能一条，实际 ${unloaded.length}`);
    assertEquals(recycled.length, 1, '回收是另一个事实，要单独一条');
    assertEquals(recycled[0].reindexed, true, '回收完成后索引必须已重建（可再次懒加载）');
  });

  // ═══════════════════════════════════════════════════════════════
  // K24-03 —— 共享引用不是环
  // ═══════════════════════════════════════════════════════════════
  runner.test('K24-03/1 合法共享引用：事实源与后一个观察者都不得被前一个观察者污染', () => {
    const d = tmp();
    const core = makeCore(d);
    const shared = { value: 'original' };
    const payload = { a: shared, b: shared, sourcePlugin: 'k24' };
    let second;
    core.on('k24.fact', (v) => { v.a.value = 'changed-by-observer'; });
    core.on('k24.fact', (v) => { second = v.b.value; });
    core.emitFact('k24.fact', payload);

    assertEquals(payload.b.value, 'original', '事实源被观察者改写了');
    assertEquals(second, 'original', '后一个观察者被前一个污染了');
    assertEquals(core.getFactDegraded().find((x) => x.event === 'k24.fact'), undefined,
      '共享引用是纯数据，不属于降级（降级就是“不可变承诺没生效”）');
  });

  runner.test('K24-03/2 真环仍然降级 + 记账（不得为了共享引用把环也放进去）', () => {
    const d = tmp();
    const core = makeCore(d);
    const cyclic = { sourcePlugin: 'k24' };
    cyclic.self = cyclic;
    core.emitFact('k24.cyclic', cyclic);
    assertEquals(core.getFactDegraded()[0]?.event, 'k24.cyclic');
  });

  runner.test('K24-03/3 深度边界：8 层深拷冻结，9 层降级', () => {
    const d = tmp();
    const core = makeCore(d);
    const make = (n) => {
      const root = { sourcePlugin: 'k24' };
      let cur = root;
      for (let i = 0; i < n; i++) { cur.next = { i }; cur = cur.next; }
      return root;
    };
    let got8; let got9;
    core.on('k24.d8', (v) => { got8 = v; });
    core.on('k24.d9', (v) => { got9 = v; });
    core.emitFact('k24.d8', make(8));   // 最深节点落在 depth 8：允许
    core.emitFact('k24.d9', make(9));   // 最深节点落在 depth 9：拒绝深拷
    assert(Object.isFrozen(got8.next), '8 层内必须深冻结');
    assertEquals(core.getFactDegraded().map((x) => x.event).join(','), 'k24.d9');
    assert(!Object.isFrozen(got9.next), '超深是“没保护到”，必须降级且可见');
  });

  runner.test('K24-03/4 非普通对象（含 getter）不得被当成纯数据深拷', () => {
    const d = tmp();
    const core = makeCore(d);
    class Handle { constructor() { this.v = 1; } }
    const handle = new Handle();
    let got;
    core.on('k24.handle', (v) => { got = v; });
    core.emitFact('k24.handle', { handle, sourcePlugin: 'k24' });
    assertEquals(got.handle, handle, '服务对象/句柄不得深拷（那会改变语义）');
    assertEquals(core.getFactDegraded()[0]?.event, 'k24.handle');
  });

  runner.test('K24-03/5 大量共享引用不得把节点计数打爆（共享子树只走一遍）', () => {
    const d = tmp();
    const core = makeCore(d);
    const shared = { value: 1 };
    const list = [];
    for (let i = 0; i < 3000; i++) list.push(shared);
    let got;
    core.on('k24.many', (v) => { got = v; });
    core.emitFact('k24.many', { list, sourcePlugin: 'k24' });
    assertEquals(core.getFactDegraded().length, 0, '3000 个共享引用仍是纯数据');
    assert(Object.isFrozen(got.list[0]), '必须是深冻结的副本');
    assertEquals(got.list[0].value, 1);
  });

  // ═══════════════════════════════════════════════════════════════
  // K24-04 —— 反查索引：建账与撤账同一份规范化
  // ═══════════════════════════════════════════════════════════════
  const PROVIDES = [
    { name: 'k24.tool', type: 'capability' },
    { name: 'k24.service', type: 'service' },
    { name: 'k24.*', type: 'capability' },
  ];
  const assertClean = (p, tag) => {
    assertEquals(p._providesIndex.has('k24.tool'), false, `${tag}：能力反查遗留`);
    assertEquals(p._svcIndex.has('k24.service'), false, `${tag}：服务反查遗留`);
    assertEquals(p._wildcardIndex.has('k24'), false, `${tag}：通配符反查遗留`);
  };

  runner.test('K24-04/1 dropLazy 与 _pending 同步撤掉三张索引（含对象/通配符形态）', () => {
    const d = tmp();
    const { pm } = freshPM(d);
    pm._indexProvides({ name: 'k24-provider', provides: PROVIDES });
    pm._pending.set('k24-provider', { provides: PROVIDES, source: 'scene' });
    assertEquals(pm.dropLazy('k24-provider'), true);
    assertClean(pm, 'dropLazy');
  });

  runner.test('K24-04/2 reconcileLazy 同样撤掉三张索引', () => {
    const d = tmp();
    const { pm } = freshPM(d);
    pm._indexProvides({ name: 'k24-provider', provides: PROVIDES });
    pm._pending.set('k24-provider', { provides: PROVIDES, source: 'scene' });
    assertEquals(pm.reconcileLazy([]).dropped.join(','), 'k24-provider');
    assertClean(pm, 'reconcileLazy');
  });

  runner.test('K24-04/3 裸字符串形态的 provides 同样能撤回', () => {
    const d = tmp();
    const { pm } = freshPM(d);
    const provides = ['k24.str', 'k24.svc', 'k24b.*'];
    pm._indexProvides({ name: 'k24-str', provides });
    pm._pending.set('k24-str', { provides, source: 'scene' });
    pm.dropLazy('k24-str');
    assertEquals(pm._providesIndex.has('k24.str'), false);
    assertEquals(pm._svcIndex.has('k24.svc'), false);
    assertEquals(pm._wildcardIndex.has('k24b'), false);
  });

  runner.test('K24-04/4 ABA：同一个键已被后继提供者接管，撤旧账不得删掉它', () => {
    const d = tmp();
    const { pm } = freshPM(d);
    pm._indexProvides({ name: 'old-owner', provides: [{ name: 'k24.shared' }, { name: 'k24w.*' }] });
    pm._pending.set('old-owner', { provides: [{ name: 'k24.shared' }, { name: 'k24w.*' }], source: 'scene' });
    pm._indexProvides({ name: 'new-owner', provides: [{ name: 'k24.shared' }, { name: 'k24w.*' }] });
    pm.dropLazy('old-owner');
    assertEquals(pm._providesIndex.get('k24.shared'), 'new-owner', '能力索引被后继接管，不得被撤掉');
    assertEquals(pm._svcIndex.get('k24.shared'), 'new-owner');
    assertEquals(pm._wildcardIndex.get('k24w'), 'new-owner', '通配符索引同理');
  });

  runner.test('K24-04/5 已装载/在运行的不许被当纯索引撤掉', async () => {
    const d = tmp();
    const { pm } = freshPM(d);
    pm._indexProvides({ name: 'k24-live', provides: [{ name: 'k24.live' }] });
    pm._pending.set('k24-live', { provides: [{ name: 'k24.live' }], source: 'scene' });
    pm._lazyLoaded.add('k24-live');
    assertEquals(pm.dropLazy('k24-live'), false, '已懒加载过的不算纯索引');
    assertEquals(pm._providesIndex.get('k24.live'), 'k24-live');
  });

  // ═══════════════════════════════════════════════════════════════
  // K24-05 —— 只有“已证明释放”的回收才能清账
  // ═══════════════════════════════════════════════════════════════
  runner.test('K24-05/1 回收未释放：保留 _lazyLoaded/_lastAccess，不得清出双实例窗口', async () => {
    const d = tmp();
    const { pm } = freshPM(d);
    pm._lazyLoaded.add('k24-still-running');
    pm._lastAccess.set('k24-still-running', 100);
    pm.lc.unload = async () => ({ ok: false, code: 'stop_timeout', released: false });
    await pm._recycle('k24-still-running');
    assertEquals(pm._lazyLoaded.has('k24-still-running'), true, '未释放却消除了已装载状态');
    assertEquals(pm._lastAccess.has('k24-still-running'), true, '未释放却清掉了访问记录');
  });

  runner.test('K24-05/2 回收已释放但在途未知（drain_timeout）：清状态但不许当场登记成“可再装”', async () => {
    const d = tmp();
    const { core, pm } = freshPM(d);
    pm._lazyLoaded.add('k24-drained');
    pm._lastAccess.set('k24-drained', 100);
    const recycled = [];
    core.on('core:plugin.recycled', (v) => recycled.push(v));
    pm.lc.unload = async () => ({ ok: false, code: 'drain_timeout', released: true, inflight: 3, forced_partial: true });

    await pm._recycle('k24-drained');
    assertEquals(pm._lazyLoaded.has('k24-drained'), false, 'released:true ⇒ 资源已撤，不得再记成“已装载”');
    assertEquals(pm._pending.has('k24-drained'), false, '在途被打断时不得当场重新登记（R21/D-4/3）');
    assertEquals(pm._lastRecycleTime.has('k24-drained'), false, '不得推进回收时间戳（不能假装回收干净完成）');
    assertEquals(recycled.length, 1);
    assertEquals(recycled[0].reindexed, false, '事实必须显式说“没有重建索引”');
    assertEquals(recycled[0].uncertain, 'drain_timeout', '不确定的原因要进事实，不能被读成安全成功');
  });

  // ═══════════════════════════════════════════════════════════════
  // 收尾：目录清理（不依赖进程退出）
  // ═══════════════════════════════════════════════════════════════
  runner.test('K24/cleanup 临时目录清理', () => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    assertEquals(dirs.length, 0);
  });
}
