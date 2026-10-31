#!/usr/bin/env node
/**
 * R19 探针：**依赖关系的全部消费者**是否与 `buildDAG` / `computeStopOrder` 用同一份解释。
 *
 * 两个反例（都按公开入口复现，不读内部字段下结论）：
 *   R19-01  运行中卸载：provider 提供 `db-service`，dependent `requires: {'db-service':'*'}` 且正在跑。
 *           正确的拒绝是"别卸载"，错误的行为是 ok:true 之后服务消失、依赖方还 running。
 *   R19-02  懒加载闭包：pending 里 provider 声明 `provides:['db-service']`，dependent `requires` 该服务。
 *           正确顺序是 provider 先 init；错误的行为是直接 init dependent 并报缺服务。
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 探针自身异常（不要把"探针写坏了"混成"代码坏了"）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Core } from '../../src/core/core.js';
import { PluginManager } from '../../src/core/plugin-manager.js';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dirs = [];
const mk = (tag) => { const d = mkdtempSync(join(tmpdir(), `r19-${tag}-`)); dirs.push(d); return d; };
const silence = (core) => { core.log = () => {}; core._stopAssemblyDrainMs = 20; return core; };

const plugin = (name, extra = {}) => ({
  name, version: '1.0.0', state: 'registered',
  init: async () => {}, start: async () => {}, stop: async () => {},
  ...extra,
});

async function main() {
  // ── R19-01：运行中卸载必须看**解析后的提供者**，不是键名相等 ──────────────
  {
    const dir = mk('unload');
    const core = silence(new Core({ stateDir: dir }));
    await core.register(plugin('provider', {
      provides: ['db-service'],
      init: async (c) => { c.registerService('db-service', { ok: true }, { owner: 'provider' }); },
    }));
    await core.register(plugin('dependent', {
      requires: { 'db-service': '*' },
      init: async (c) => { if (!c.getService('db-service')) throw new Error('MISSING_DB_SERVICE'); },
    }));
    await core.start();

    let refused = false;
    let detail = '';
    try {
      const r = await core.lifecycle.unload('provider');
      detail = `unload 返回 ${JSON.stringify(r)}`;
      refused = r?.ok === false;
    } catch (err) {
      refused = true;
      detail = err.message;
    }
    const providerStillThere = core.plugins.has('provider');
    const dependentRunning = core.plugins.get('dependent')?.state === 'running';
    check('R19-01 卸载仍被运行中插件依赖的服务提供者必须被拒', refused, detail);
    check('R19-01 拒绝之后：provider 仍在、dependent 仍 running',
      refused && providerStillThere && dependentRunning,
      `provider=${providerStillThere} dependent=${core.plugins.get('dependent')?.state}`);

    // 合法正例：不被需要的提供者必须能卸（不得"一律拒绝"）
    const core2 = silence(new Core({ stateDir: mk('unload-ok') }));
    await core2.register(plugin('lonely', { provides: ['lonely-svc'] }));
    await core2.start();
    let unloaded = null;
    try { unloaded = await core2.lifecycle.unload('lonely'); } catch (err) { unloaded = { ok: false, error: err.message }; }
    check('R19-01【正例】没有依赖方的提供者可以正常卸载', unloaded?.ok === true, JSON.stringify(unloaded));

    // 合法正例：可选依赖不阻止卸载
    const core3 = silence(new Core({ stateDir: mk('unload-optional') }));
    await core3.register(plugin('prov3', { provides: ['opt-svc'] }));
    await core3.register(plugin('user3', { optional: { 'opt-svc': '*' } }));
    await core3.start();
    let optUnload = null;
    try { optUnload = await core3.lifecycle.unload('prov3'); } catch (err) { optUnload = { ok: false, error: err.message }; }
    check('R19-01【正例】optional 依赖不阻止卸载', optUnload?.ok === true, JSON.stringify(optUnload));
    core.removeAllListeners(); core2.removeAllListeners(); core3.removeAllListeners();
  }

  // ── R19-02：懒加载闭包必须把**服务提供者**拉进来，且先于依赖方 init ──────
  {
    const dir = mk('lazy');
    const pluginDir = join(dir, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(pluginDir, 'provider.mjs'), `
export const name = 'provider';
export const version = '1.0.0';
export const provides = ['db-service'];
export default {
  name, version, provides,
  init: async (core) => {
    core.setData('r19.initOrder', [...(core.getData('r19.initOrder') || []), 'provider']);
    core.registerService('db-service', { ok: true }, { owner: 'provider' });
  },
};
`);
    writeFileSync(join(pluginDir, 'dependent.mjs'), `
export const name = 'dependent';
export const version = '1.0.0';
export const provides = ['dependent.work'];
export const requires = { 'db-service': '*' };
export default {
  name, version, provides, requires,
  init: async (core) => {
    if (!core.getService('db-service')) throw new Error('MISSING_DB_SERVICE');
    core.setData('r19.initOrder', [...(core.getData('r19.initOrder') || []), 'dependent']);
    core.registerCapability('dependent.work', { handler: async () => ({ ok: true }) });
  },
};
`);
    const core = silence(new Core({ stateDir: dir, pluginsDir: pluginDir }));
    const pm = new PluginManager(core);
    pm.addDirectory(pluginDir);
    await pm.loadAll([], ['provider', 'dependent']);

    // 装载失败可能以 reject 形式冒出来（那是 Attempt 的真实结论），必须当成"失败证据"，
    // 不能让探针自己崩掉 —— 否则"代码坏了"与"探针写坏了"就分不清了。
    let resolveError = null;
    try { await pm._resolveLazy('dependent.work'); } catch (err) { resolveError = err; }
    const order = core.getData('r19.initOrder') || [];
    const providerState = core.plugins.get('provider')?.state;
    const dependentState = core.plugins.get('dependent')?.state;
    check('R19-02 懒加载必须先把服务提供者装进来',
      providerState === 'running' && dependentState === 'running',
      `provider=${providerState} dependent=${dependentState} order=${JSON.stringify(order)}`
      + (resolveError ? ` err=${resolveError.message}` : ''));
    check('R19-02 提供者必须先于依赖方 init',
      order.join('->') === 'provider->dependent', JSON.stringify(order));

    // 合法正例：没有服务依赖的懒插件不被误装
    writeFileSync(join(pluginDir, 'standalone.mjs'), `
export const name = 'standalone';
export const version = '1.0.0';
export const provides = ['standalone.cap'];
export default {
  name, version, provides,
  init: async (core) => { core.registerCapability('standalone.cap', { handler: async () => ({ ok: true }) }); },
};
`);
    const core2 = silence(new Core({ stateDir: mk('lazy-ok'), pluginsDir: pluginDir }));
    const pm2 = new PluginManager(core2);
    pm2.addDirectory(pluginDir);
    await pm2.loadAll([], ['provider', 'dependent', 'standalone']);
    await pm2._resolveLazy('standalone.cap');
    check('R19-02【正例】独立懒插件不被连带，也不连带别人',
      core2.plugins.has('standalone') && !core2.plugins.has('dependent') && !core2.plugins.has('provider'),
      `standalone=${core2.plugins.has('standalone')} dependent=${core2.plugins.has('dependent')} provider=${core2.plugins.has('provider')}`);
    core.removeAllListeners(); core2.removeAllListeners();
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR19 探针：${results.length - failed} 通过 / ${failed} 失败`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } process.exit(code); })
  .catch((err) => {
    console.error(`[探针自身异常] ${err?.stack || err}`);
    for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    process.exit(2);
  });
