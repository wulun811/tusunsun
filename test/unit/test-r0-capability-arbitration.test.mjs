// R0-2 能力注册仲裁（先红后绿）
//
// 对应专家 R0-2：重复注册默认具名拒绝；替换需明确所有权。
// 背景（第三份报告 §4.1 实测）：registerCapability 用 Map.set 直接覆盖，
// chat.handle 被 4 处注册、静默 last-writer-wins，能力表 size 恒为 1。

import { TestRunner, assert, assertEquals, assertThrows } from '../harness.mjs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const CORE = join(HERE, '..', '..', 'src', 'core', 'core.js');
const url = (p) => new URL(`file://${p}`).href;

export async function setup(runner) {
  const mod = await import(url(CORE));
  const Core = mod.default ?? mod.Core ?? Object.values(mod).find((v) => typeof v === 'function');

  function newCore() {
    const c = new Core({});
    c.log = () => {};      // 静音
    return c;
  }

  runner.test('R0-2/A: 同 ID 重复注册默认被具名拒绝', () => {
    const core = newCore();
    core.registerCapability('x.cap', { handler: () => 'first', owner: 'plugin-a' });
    assertThrows(
      () => core.registerCapability('x.cap', { handler: () => 'second', owner: 'plugin-b' }),
      '第二个提供者不声明替换时必须被拒绝',
    );
    // 具名错误码
    let msg = '';
    try { core.registerCapability('x.cap', { handler: () => 'x', owner: 'plugin-b' }); } catch (e) { msg = e.message; }
    assert(/capability_conflict/.test(msg), `错误应具名 capability_conflict，实际：${msg}`);
    // 原提供者仍然有效（未被静默覆盖）
    assertEquals(core._capabilities.size, 1, '能力表不应多出条目');
    assertEquals(core._capabilities.get('x.cap').owner, 'plugin-a', '原所有者不得被静默覆盖');
  });

  runner.test('R0-2/B: 持原登记凭据的替换允许', () => {
    const core = newCore();
    const h = core.registerCapability('x.cap', { handler: () => 'v1', owner: 'plugin-a' });
    core.registerCapability('x.cap', { handler: () => 'v2', owner: 'plugin-a', overrideBy: h });
    assertEquals(core._capabilities.get('x.cap').owner, 'plugin-a');
    assertEquals(core._capabilities.get('x.cap').handler(), 'v2', '同一登记可显式热替换');
  });

  runner.test('R0-2/C: 不同所有者夺取他人能力需显式让渡，否则拒绝', () => {
    const core = newCore();
    const h = core.registerCapability('x.cap', { handler: () => 'a', owner: 'plugin-a' });
    // 他人声明 override 但原所有者未让渡 → 拒绝（防插件任意夺取他人入口）
    assertThrows(
      () => core.registerCapability('x.cap', { handler: () => 'b', owner: 'plugin-b', override: true }),
      '跨所有者夺取必须被拒绝',
    );
    // 原所有者显式让渡（持凭据）后，他人可接手
    assertEquals(core.releaseRegistration(h), true);
    core.registerCapability('x.cap', { handler: () => 'b', owner: 'plugin-b' });
    assertEquals(core._capabilities.get('x.cap').owner, 'plugin-b', '让渡后应可接手');
  });

  runner.test('R0-2/D: 注册冲突发出可观测事件（对齐 registerService 既有行为）', () => {
    const core = newCore();
    const seen = [];
    core.on('core:capability.conflict', (e) => seen.push(e));
    core.registerCapability('x.cap', { handler: () => 'a', owner: 'plugin-a' });
    try { core.registerCapability('x.cap', { handler: () => 'b', owner: 'plugin-b' }); } catch { /* 预期抛错 */ }
    assertEquals(seen.length, 1, '冲突必须发出事件，不得静默');
    assertEquals(seen[0].capability ?? seen[0].id, 'x.cap');
  });

  runner.test('R0-2/E: 卸载/让渡后可重新注册（不出现隐式覆盖）', () => {
    const core = newCore();
    const h = core.registerCapability('x.cap', { handler: () => 'a', owner: 'plugin-a' });
    assertEquals(core.releaseRegistration(h), true);
    assertEquals(core._capabilities.has('x.cap'), false, '让渡后能力表应清除该条目');
    core.registerCapability('x.cap', { handler: () => 'c', owner: 'plugin-c' });
    assertEquals(core._capabilities.get('x.cap').owner, 'plugin-c');
  });

  runner.test('R0-2/F: 无所有者声明的重复注册同样被拒绝', () => {
    const core = newCore();
    core.registerCapability('x.cap', { handler: () => 'a' });
    assertThrows(() => core.registerCapability('x.cap', { handler: () => 'b' }), '匿名重复注册也应拒绝');
  });

  runner.test('R0-2/G: 非所有者无权让渡他人能力（且字符串本身不是授权）', () => {
    const core = newCore();
    core.registerCapability('x.cap', { handler: () => 'a', owner: 'plugin-a' });
    let code = null;
    try { core.releaseCapability('x.cap', 'plugin-b'); } catch (e) { code = e.code; }
    assertEquals(code, 'capability_release_denied', '非所有者不得让渡');
    assertEquals(core._capabilities.get('x.cap').owner, 'plugin-a', '能力应保持不变');
  });
}
