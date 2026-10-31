import { TestRunner } from '../harness.mjs';
import assert from 'node:assert/strict';
import { Core } from '../../src/core/core.js';
import { LifecycleManager } from '../../src/core/lifecycle-manager.js';
// 平台测试必须验平台树（src/）：此前误指过兼容副本，一旦脱离本仓库布局即失效
import { SecretsManager } from '../../plugins/_lib/secrets.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// W7-A3 自写修复回归：B-04（服务追踪 ALS 并发隔离）+ B-09（secrets setAndSave 持久化）

export async function setup(runner) {
  let testDir;
  let stderrOutput;
  let originalStderrWrite;

  runner.beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'tusunsun-b04-b09-'));
    stderrOutput = '';
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
  });

  runner.afterEach(() => {
    process.stderr.write = originalStderrWrite;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  runner.test('B-04: runServiceTracking 收集本链路消费的服务名', async () => {
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    core.registerService('alpha', {});
    const consumed = await core.runServiceTracking('p1', async () => {
      core.getService('alpha');
      core.getService('missing-svc');
      await new Promise((r) => setTimeout(r, 5));
      core.getService('alpha');
    });
    assert.deepEqual([...consumed].sort(), ['alpha', 'missing-svc']);
    core.removeAllListeners();
  });

  runner.test('B-04: 并发交错加载的追踪集互不污染', async () => {
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    core.registerService('svc-a', {});
    core.registerService('svc-b', {});
    const gate = new Promise((r) => setTimeout(r, 10));
    // p1 先消费 svc-a，中途让位；p2 只消费 svc-b。旧实现（单例 Set）会让两集互相覆盖。
    const p1 = core.runServiceTracking('p1', async () => {
      core.getService('svc-a');
      await gate;
      core.getService('svc-a');
    });
    const p2 = core.runServiceTracking('p2', async () => {
      await new Promise((r) => setTimeout(r, 2));
      core.getService('svc-b');
    });
    const [s1, s2] = await Promise.all([p1, p2]);
    assert.deepEqual([...s1].sort(), ['svc-a']);
    assert.deepEqual([...s2].sort(), ['svc-b']);
    core.removeAllListeners();
  });

  runner.test('B-04: ALS 内 registerService 归属本插件；legacy 全局字段保持回退语义', async () => {
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    await core.runServiceTracking('owner-x', async () => {
      core.registerService('svc-owned', {});
    });
    assert.equal(core._serviceOwners.get('svc-owned'), 'owner-x');
    // 回退：无 ALS 上下文时 legacy 全局开关仍生效（既有行为不回退）
    core._trackServiceAccess = true;
    core.getService('legacy-svc');
    assert.ok(core._trackedServices.has('legacy-svc'));
    core._trackServiceAccess = false;
    core.removeAllListeners();
  });

  runner.test('B-04: LifecycleManager 加载后 legacy 全局态保持干净（既有断言语义）', async () => {
    const core = new Core({ stateDir: testDir, pluginsDir: join(testDir, 'plugins') });
    const lc = new LifecycleManager(core);
    await lc.load({ name: 'plain', version: '1.0.0', init: async () => { core.getService('nope'); } }, core, {});
    assert.equal(core._initOwner, null);
    assert.equal(core._trackServiceAccess, false);
    core.removeAllListeners();
  });

  runner.test('B-09: secrets set 经 setAndSave 落盘，get 重启视角（新实例）可读回', async () => {
    process.env.TUSUNSUN_SECRET_KEY = 'b09-test-master-key';
    const core = { stateDir: testDir, log() {}, getService: () => null };
    const sm1 = new SecretsManager(core);
    const cfgPath = join(testDir, 'config.json');
    const persisted = {};
    const configStub = {
      get: (name) => persisted[name],
      setAndSave: async (name, value) => {
        if (value === undefined) delete persisted[name];
        else persisted[name] = value;
        writeFileSync(cfgPath, JSON.stringify(persisted));
      },
    };
    core.getService = () => configStub;

    await sm1.set('api_key', 'sekrit-value');
    assert.ok(existsSync(cfgPath), '密文必须已落盘');
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.ok(onDisk.api_key && onDisk.api_key.includes('"iv":"'), '落盘的是加密包而非明文');
    assert.ok(!JSON.stringify(onDisk).includes('sekrit-value'), '明文不得落盘');

    const sm2 = new SecretsManager(core);
    assert.equal(sm2.get('api_key'), 'sekrit-value', '重启后（新实例、空缓存）可从盘读回');
  });

  runner.test('B-09: secrets delete 经 setAndSave 落盘，重启后不复活', async () => {
    process.env.TUSUNSUN_SECRET_KEY = 'b09-test-master-key';
    const persisted = {};
    const cfgPath = join(testDir, 'config.json');
    const configStub = {
      get: (name) => persisted[name],
      setAndSave: async (name, value) => {
        if (value === undefined) delete persisted[name];
        else persisted[name] = value;
        writeFileSync(cfgPath, JSON.stringify(persisted));
      },
    };
    const core = { stateDir: testDir, log() {}, getService: () => configStub };
    const sm = new SecretsManager(core);
    await sm.set('gone_soon', 'tmp');
    await sm.delete('gone_soon');
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(onDisk.gone_soon, undefined, '删除必须落盘（旧实现只改内存，重启复活）');
    assert.equal(sm.has('gone_soon'), false);
  });
}
