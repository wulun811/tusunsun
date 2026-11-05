// R0-176：插件装载失败只打一行日志，readiness 仍报 READY。
//
// 实测形状：故意放一个 import 就炸的插件，日志里一条 error，紧接着
// `[readiness] READY（plugins=9 failed=0 criticalFailed=0）`。对使用者这是最坏的组合。
// 判据：装载失败必须落成只读事实（`core._startFailures`，与 init 失败同一本账），
// readiness 因此变 degraded 并点名那个文件；好插件不受连坐。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

export default async function (runner) {
  runner.test('R0-176 装载失败的插件进 _startFailures，readiness 报 degraded 并点名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tss-r0176-'));
    try {
      writeFileSync(join(dir, 'good-one.js'),
        "class Good {\n  name = 'good-one';\n  version = '1.0.0';\n  async init() {}\n}\nexport default new Good();\n");
      writeFileSync(join(dir, 'zzz-broken.js'),
        "import 'pkg-nope-t06';\nclass Broken {\n  name = 'zzz-broken';\n  version = '1.0.0';\n}\nexport default new Broken();\n");

      const { Core } = await imp('src/core/core.js');
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const core = new Core({ stateDir: join(dir, 'state') });
      core.log = () => {};
      const pm = new PluginManager(core);
      pm.addDirectory(dir);
      await pm.loadAll(['good-one', 'zzz-broken'], []);

      assertEquals(core.plugins.has('good-one'), true, '好插件必须照常装载（失败要隔离，不能连坐）');
      const rec = core._startFailures.get('zzz-broken.js');
      assert(rec, `装载失败必须留下事实，实际 _startFailures=${JSON.stringify([...core._startFailures.keys()])}`);
      assertEquals(rec.phase, 'load', '阶段必须是 load（与 init 失败同账不同事）');
      assert(/pkg-nope-t06/.test(rec.error), `事实里必须带原始错误，实际 ${rec.error}`);
      assertEquals(rec.requiredFailed, false, '装载失败不是 required 失败');

      const readiness = (await imp('plugins/readiness.js')).default;
      await readiness.init(core);
      const s = core.getService('readiness').status();
      assertEquals(s.status, 'degraded', `readiness 不得再报 ready，实际 ${JSON.stringify(s)}`);
      assert(s.failed.includes('zzz-broken.js'), `failed 必须点名那个文件，实际 ${JSON.stringify(s.failed)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
