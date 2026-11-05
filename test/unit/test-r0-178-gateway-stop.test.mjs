// R0-178：网关停机调用一个不存在的 `core.shutdown`，可选链把整段停机
// 静默成空操作，紧接着 process.exit(0) ⇒ 所有插件 stop() 一次都没被调用。
//
// 判据三条，锁的都是行为/事实而不是注释：
//   T1 Core 上根本没有 shutdown（旧写法是死的，不是“尽力而为”）
//   T2 网关的 core.stop 分支调的是 core.stop()，并且真的被调用一次
//   T3 core.stop() 真的逐个跑插件 stop()（这里数的是 stop() 实际执行条数）
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (runner) {
  runner.test('R0-178 Core 没有 shutdown：旧的 `core.shutdown?.()` 是静默空操作（事实锁）', async () => {
    const { Core } = await imp('src/core/core.js');
    const dir = mkdtempSync(join(tmpdir(), 'tss-r0178-'));
    try {
      const core = new Core({ stateDir: join(dir, 'state') });
      assertEquals('shutdown' in core, false,
        'Core 上若真出现了 shutdown，R0-178 的判据要重写；当前它不存在，所以旧写法什么也没做');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  runner.test('R0-178 网关 core.stop 分支：调的是 core.stop()，且只调一次', async () => {
    const GW = (await imp('plugins/gateway.js')).default;
    const calls = [];
    const origCore = GW.core;
    const origClients = GW.clients;
    const origExit = process.exit;
    let exited = false;
    GW.core = { log: () => {}, stop: async () => { calls.push(Date.now()); } };
    GW.clients = new Map();
    process.exit = () => { exited = true; };
    try {
      await GW._handleRequest('probe-conn', { id: 1, method: 'core.stop' });
      await sleep(700);   // 分支里 setTimeout(…, 500) 之后才收尾
      assertEquals(calls.length, 1, `core.stop 必须被调用一次，实际 ${calls.length}`);
      assertEquals(exited, true, '收尾必须退出进程（否则 CLI 的 stop 会挂在那里）');
    } finally {
      process.exit = origExit;
      GW.core = origCore;
      GW.clients = origClients;
    }
  });

  runner.test('R0-178 core.stop() 真的逐个跑插件 stop()（不是只改状态位）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tss-r0178-'));
    const marker = join(dir, 'stopped.txt');
    try {
      writeFileSync(join(dir, 'plug-a.js'), `
import { appendFileSync } from 'node:fs';
class A {
  name = 'plug-a';
  version = '1.0.0';
  async init() {}
  async stop() { appendFileSync(${JSON.stringify(marker)}, 'a\\n'); }
}
export default new A();
`);
      const { Core } = await imp('src/core/core.js');
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const core = new Core({ stateDir: join(dir, 'state') });
      core.log = () => {};
      const pm = new PluginManager(core);
      pm.addDirectory(dir);
      await pm.loadAll(['plug-a'], []);
      await core.start();
      await core.stop();
      let body = '';
      try { body = readFileSync(marker, 'utf8'); } catch { body = ''; }
      assertEquals(body.trim(), 'a', `插件 stop() 必须被调用一次，实际文件内容 ${JSON.stringify(body)}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
