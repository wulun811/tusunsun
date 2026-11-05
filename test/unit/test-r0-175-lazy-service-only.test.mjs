// R0-175：lazy 的触发面只有能力名，只提供 service 的 lazy 插件永远装不上。
//
// 真实接入里遇到的坏组合：validateAssembly 把 lazy 的服务算作可用 provider（放行且无告警），
// 运行期 getService 恒 undefined —— 两个子系统对同一件事给出相反答案。
// 判据三条：准入必须判 degraded 并点名；混装的不误伤；运行期事实被锁住（getService 不触发）。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';
import { validateAssembly } from '../../plugins/admission-gate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const lazyIndex = (provides) => new Map([['svc-only', { version: '1.0.0', provides }]]);

export default async function (runner) {
  runner.test('R0-175 只提供 service 的 lazy 插件：准入判 degraded 并单独点名（不再静默放行）', () => {
    const r = validateAssembly([], lazyIndex([{ name: 'svc-only-svc', type: 'service' }]));
    assertEquals(r.violations.length, 0, '这不是配置错误，不该记违例（违例会在 production 拒启动）');
    assert(r.degraded.includes('svc-only'), `必须以 degraded 出现，实际 ${JSON.stringify(r.degraded)}`);
    assert(r.serviceOnlyLazy.includes('svc-only'), `必须能被单独点名，实际 ${JSON.stringify(r.serviceOnlyLazy)}`);
  });

  runner.test('R0-175 不误伤：同时声明了能力的 lazy 插件不判 degraded', () => {
    const r = validateAssembly([], lazyIndex([
      { name: 'svc-only-svc', type: 'service' },
      { name: 'cap.thing' },
    ]));
    assertEquals(r.degraded.includes('svc-only'), false, `混装插件不该被点名，实际 ${JSON.stringify(r.degraded)}`);
  });

  runner.test('R0-175 运行期事实：getService 不触发懒加载，只有能力名入口会（这就是告警的理由）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tss-r0175-'));
    try {
      writeFileSync(join(dir, 'svc-only.js'), [
        'class SvcOnly {',
        "  name = 'svc-only';",
        "  version = '1.0.0';",
        "  provides = [{ name: 'svc-only-svc', type: 'service' }];",
        "  async init(core) { core.registerService('svc-only-svc', { ping: () => 'pong' }); }",
        '}',
        'export default new SvcOnly();',
      ].join('\n'));
      const { Core } = await imp('src/core/core.js');
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const core = new Core({ stateDir: join(dir, 'state') });
      core.log = () => {};
      const pm = new PluginManager(core);
      pm.addDirectory(dir);
      await pm.loadAll([], ['svc-only']);

      assertEquals(core.getService('svc-only-svc'), undefined,
        'getService 直接读服务表；这里若拿到了，“必须放 eager”就成了假警报');
      assertEquals(core._services.has('svc-only-svc'), false, '未触发前服务表里不该有它');

      const has = await core.hasCapability('svc-only-svc');   // 能力名入口 → 才会触发装载
      assertEquals(has, false, '它没有注册任何能力，hasCapability 只能回答 false');
      assert(core.getService('svc-only-svc')?.ping?.() === 'pong',
        '触发之后服务必须真的在（证明“装得上，只是没人触发”）');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
