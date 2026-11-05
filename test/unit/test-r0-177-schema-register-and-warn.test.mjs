// R0-177：schema 支持面窄于发布的能力契约，一个能力写宽就整插件装不上。
//
// 真实接入实测：7 个 MCP 工具里 6 个因 enum/pattern/items/type[]/嵌套 properties 注册失败，
// 只能各自写一遍“窄投影 + 自校验”，语义漂移风险全压在使用方。
// 新口径：照登记 + 具名告警 + 记在能力条目上（`schema_unvalidated`）；能判的照常判。
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

const WIDE = {
  type: 'object',
  required: ['expected_hash'],
  properties: {
    expected_hash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    mode: { type: 'string', enum: ['fast', 'safe'] },
    tags: { type: 'array', items: [] },
    optional_ref: { type: ['string', 'null'] },
    nested: { type: 'object', properties: { a: { type: 'string' } } },
    label: { type: 'string', minLength: 1 },
  },
};

// 每个用例一个 stateDir：Core 对 stateDir 是独占的，共用会让后面的用例撞上 state_dir_owned。
const newCore = async () => {
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(mkdtempSync(join(tmpdir(), 'tss-r0177-')), 'state') });
  core.log = () => {};
  return core;
};

export default async function (runner) {
  runner.test('R0-177 宽 schema（enum/pattern/items/type[]/嵌套）：登记成功，且逐条记成未生效', async () => {
    const core = await newCore();
    const warns = [];
    core.log = (level, msg) => { if (level === 'warn') warns.push(String(msg)); };
    core.registerCapability('t07.wide', { owner: 'test', handler: async () => 'ok', input_schema: WIDE });

    const issues = core._capabilities.get('t07.wide')?.schema_unvalidated || [];
    const kws = issues.map((i) => i.keyword);
    for (const kw of ['pattern', 'enum', 'items', 'properties', 'minLength']) {
      assert(kws.includes(kw), `未生效清单必须点名 ${kw}，实际 ${JSON.stringify(kws)}`);
    }
    assert(!kws.includes('type'), `R0-179：type 并集是判得了的，不得再记成未生效，实际 ${JSON.stringify(kws)}`);
    assert(issues.some((i) => i.assertional), 'pattern/enum 这类能改变准入结论的关键字必须标成 assertional');
    assert(warns.some((w) => /\[schema\]/.test(w) && /未生效/.test(w)), `必须具名告警，实际 ${JSON.stringify(warns)}`);

    const row = core.listCapabilities().find((c) => c.id === 't07.wide');
    assert(row?.schema_unvalidated?.includes('enum'), 'listCapabilities 必须能枚举出未生效关键字');
  });

  runner.test('R0-177 能判的照常判：required / type 仍然拦住非法入参（登记不等于放行）', async () => {
    const core = await newCore();
    core.registerCapability('t07.enforced', { owner: 'test', handler: async () => 'ok', input_schema: WIDE });
    const missing = await core.callCapability('t07.enforced', {});
    assertEquals(missing.ok, false, '缺 required 必须被拦');
    assertEquals(missing.code, 'invalid_input', `应具名 invalid_input，实际 ${JSON.stringify(missing).slice(0, 120)}`);
    const wrongType = await core.callCapability('t07.enforced', { expected_hash: 123 });
    assertEquals(wrongType.ok, false, 'expected_hash 声明了 string，传 123 必须被拦');
    const ok = await core.callCapability('t07.enforced', { expected_hash: 'sha256:' + 'a'.repeat(64) });
    assertEquals(ok.ok, true, '声明了但内核不判的关键字（pattern）不应让合法入参被拒');
    const nullable = await core.callCapability('t07.enforced', { expected_hash: 'sha256:' + 'a'.repeat(64), optional_ref: null });
    assertEquals(nullable.ok, true, 'R0-179：声明的 [string,null] 并集必须真判（null 是合法值）');
  });

  runner.test('R0-177 声明读取隔离不退化：getter 仍进不了权威记录', async () => {
    const core = await newCore();
    const s = {};
    Object.defineProperty(s, 'properties', { enumerable: true, get: () => ({ x: { type: 'string' } }) });
    let err = null;
    try { core.registerCapability('t07.getter', { owner: 'test', handler: async () => 1, input_schema: s }); } catch (e) { err = e; }
    assert(err, 'getter 声明必须在进入支持面体检之前被拒（两趟读取 = 审一个、存另一个）');
    assertEquals(err.code, 'declaration_not_pure_data', `应具名 declaration_not_pure_data，实际 ${err.code || err.message}`);
  });

  runner.test('R0-177 override 继承旧 schema 时，未生效清单跟着继承（不重算成空）', async () => {
    const core = await newCore();
    const h = core.registerCapability('t07.inherit', { owner: 'test', handler: async () => 1, input_schema: WIDE });
    core.registerCapability('t07.inherit', { owner: 'test', handler: async () => 2, overrideBy: h });
    const issues = core._capabilities.get('t07.inherit')?.schema_unvalidated || [];
    assert(issues.some((i) => i.keyword === 'enum'),
      `继承来的 schema 的未生效清单不得被清空，实际 ${JSON.stringify(issues.map((i) => i.keyword))}`);
  });
}
