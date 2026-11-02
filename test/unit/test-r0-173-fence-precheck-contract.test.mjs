// R0-173：围栏 `preCheck` 的**位置参数契约**
//
// 契约：`preCheck(tool, args, sessionId, chainId, fenceCtx)` —— 5 个位置参数，第 5 个是上下文对象。
// 自带 `_lib/kunxiansuo/local-fence.js` 曾声明 6 参（第 5 参 expertId、第 6 参 fenceCtx）。
// 两个自带插件各自做了适配，所以发布物自身不受影响；但任何**按平台接口直接装配 LocalFence
// 实例**的第三方，都会把 fenceCtx 传进 expertId 槽：`irreversibleAcknowledged` 静默丢失
// （确认过的 `mv` 仍被 CMD_GUARD 拒绝），且每调一次白查一次 `core.get('experts.[object Object]')`。
//
// 锁的是**行为**：每个登记的围栏到底收到几个参数、第 5 个是什么；不是扫源码正则。
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertEquals, assert } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

export async function setup(runner) {
  const tmp = mkdtempSync(join(tmpdir(), 'tt-r0173-'));
  runner.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // 只装 config + tool-executor：围栏由用例自己登记，避免与 `kunxiansuo-local` 抢同一个 core 的那一份
  // （`resolveFence` 按登记顺序取第一条 core 归属记录，两个都登记时测的就不是自己装的那个了）。
  const boot = async () => {
    const { createRuntime } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const stateDir = join(mkdtempSync(join(tmp, 'state-')), 's');
    const rt = createRuntime({ stateDir, pluginsDir: join(ROOT, 'plugins') });
    const pm = new PluginManager(rt.core);
    rt.core.registerService('plugin-manager', pm);
    pm.addDirectory(join(ROOT, 'plugins'));
    await pm.loadAll(['config', 'tool-executor']);
    await rt.core.start();
    return { rt, exec: rt.core.getService('tool-executor') };
  };

  runner.test('R0-173/T1 平台调用形态：正好 5 个位置参数，第 5 个是 fenceCtx 对象', async () => {
    const { rt, exec } = await boot();
    const { setFence, removeFence } = await imp('plugins/tool-executor.js');
    const seen = [];
    const inst = setFence({ preCheck(...a) { seen.push(a); return { ok: true }; } }, { owner: 'probe-arity', core: rt.core });
    try {
      await rt.core.getService('config').setAndSave('tools.permissionMode', 'full-auto');
      await exec._checkPreFlight('tool-bash', { command: 'mv /tmp/a /tmp/b' }, 's1', 'chain-1');
      assertEquals(seen.length, 1, '围栏必须被真的调用一次');
      const a = seen[0];
      assertEquals(a.length, 5, `平台必须只传 5 个位置参数，实际传了 ${a.length} 个`);
      assertEquals(a[0], 'tool-bash', '第 1 参是工具名');
      assertEquals(a[2], 's1', '第 3 参是 sessionId');
      assertEquals(a[3], 'chain-1', '第 4 参是 chainId');
      assert(a[4] && typeof a[4] === 'object', '第 5 参必须是 fenceCtx 对象（不是字符串、不是 undefined）');
      assertEquals(a[4].irreversibleAcknowledged, true, 'full-auto 的确认标记必须落在第 5 参上');
      console.log('       [实测] 平台传参 (tool, args, sessionId, chainId, ctx)，ctx.irreversibleAcknowledged=true');
    } finally { removeFence(inst); await rt.core.stop(); }
  });

  runner.test('R0-173/T2 第三方直接登记 LocalFence：确认标记不得落进 expertId 槽', async () => {
    const { rt, exec } = await boot();
    const { LocalFence } = await imp('plugins/_lib/kunxiansuo/local-fence.js');
    const { FileSystemGuard } = await imp('plugins/_lib/kunxiansuo/file-guard.js');
    const { setFence, removeFence, fenceStatus } = await imp('plugins/tool-executor.js');

    const lf = new LocalFence(rt.core);
    // 第三方要自己接命令判据：不接时 `CMD_GUARD` 根本不会触发，这条用例就成了假绿。
    lf._fsGuard = new FileSystemGuard({});
    const inst = setFence(lf, { owner: 'third-party', core: rt.core });

    const asked = [];
    const origGet = rt.core.get.bind(rt.core);
    rt.core.get = (k, fb) => { asked.push(k); return origGet(k, fb); };
    try {
      // 反向先确认围栏真的在跑：敏感路径照拦（与修不修这条契约无关）
      const env0 = await exec._checkPreFlight('tool-write', { path: '.env' }, 's1', null);
      assertEquals(env0?.diagnostic?.code, 'FS_GUARD', '围栏必须真的在跑（否则下面的“放行”毫无意义）');

      await rt.core.getService('config').setAndSave('tools.permissionMode', 'full-auto');
      const mv = await exec._checkPreFlight('tool-bash', { command: 'mv /tmp/a /tmp/b' }, 's1', null);
      assert(!mv?.status, `full-auto 的确认标记必须送到围栏：mv 仍被 ${mv?.diagnostic?.code} 拒绝`);

      const env = await exec._checkPreFlight('tool-write', { path: '.env' }, 's1', null);
      assertEquals(env?.diagnostic?.code, 'FS_GUARD', '敏感路径判据不随确认一起让路');

      const bad = asked.filter((k) => String(k).includes('[object Object]'));
      assertEquals(bad.length, 0, `不得把上下文对象拼进配置键查询：${bad.join(', ')}`);
      assertEquals(fenceStatus(rt.core).owner, 'third-party', '观测面与判据必须同源');
      console.log('       [实测] 第三方 LocalFence：mv 放行、.env 仍 FS_GUARD，未查 experts.[object Object]');
    } finally { rt.core.get = origGet; removeFence(inst); await rt.core.stop(); }
  });

  runner.test('R0-173/T3 工具白名单改从 ctx 取：位置参数不再被借用', async () => {
    const { LocalFence } = await imp('plugins/_lib/kunxiansuo/local-fence.js');
    const cfg = new Map([['experts.e1', { toolsAllow: ['tool-read'] }]]);
    const asked = [];
    const core = {
      get: (k) => { asked.push(k); return cfg.get(k); },
      getData: () => undefined,
      getService: () => null,
    };
    const lf = new LocalFence(core);

    const denied = lf.preCheck('tool-bash', { command: 'ls' }, 's1', null, { expertId: 'e1' });
    assertEquals(denied.ok, false, 'ctx 带 expertId 时白名单必须生效');
    assertEquals(denied.code, 'EXPERT_TOOL_DENIED');
    assert(/tool-read/.test(denied.hint || ''), '提示里要列出白名单本身');

    const allowed = lf.preCheck('tool-read', { path: 'x' }, 's1', null, { expertId: 'e1' });
    assertEquals(allowed.ok, true, '白名单内的工具不得被误拦');

    asked.length = 0;
    lf.preCheck('tool-bash', { command: 'ls' }, 's1', null, null);
    assertEquals(asked.filter((k) => /^experts\./.test(String(k))).length, 0,
      'ctx 没有 expertId 时不得去查 experts.*（修前查的是 experts.[object Object]）');
    console.log('       [实测] 白名单从 ctx 读：e1 拒 tool-bash、放 tool-read；无 ctx 时零 experts.* 查询');
  });

  runner.test('R0-173/T4 声明超过 5 个位置参数的围栏，登记时就要出声（不许静默）', async () => {
    const { setFence, removeFence } = await imp('plugins/tool-executor.js');
    const warnings = [];
    const onWarn = (w) => warnings.push(w);
    process.on('warning', onWarn);
    const c1 = { tag: 'arity-six' }, c2 = { tag: 'arity-five' };
    const i1 = setFence({ preCheck(a, b, c, d, e, f) { return { ok: true }; } }, { owner: 'six', core: c1 });
    const i2 = setFence({ preCheck(a, b, c, d, e) { return { ok: true }; } }, { owner: 'five', core: c2 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      const hit = warnings.filter((w) => w.name === 'TusunFenceArity');
      assertEquals(hit.length, 1, `只应给 6 参围栏报一次，实际 ${hit.length} 次`);
      assert(/six/.test(hit[0].message), '警告必须点名是哪个 owner 的围栏');
      assert(!warnings.some((w) => /"five"/.test(w.message)), '正好 5 参的围栏不得被误报');
      console.log('       [实测] 6 参围栏登记时发 TusunFenceArity，5 参不报');
    } finally {
      process.off('warning', onWarn);
      removeFence(i1); removeFence(i2);
    }
  });
}
