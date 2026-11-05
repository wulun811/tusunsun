// R0-179：`input_schema` 里写 draft-07 的**并集类型**（`type: ['integer','null']`）
// 时，登记成功、记账也正确，但 `_schemaViolation` 拿 `typeof` 的结果与数组做 `===`，恒不相等 ⇒
// 该参数**每次调用**都被判非法（`integer` 的 5 被拒、`null` 被拒、根对象被拒）。
//
// R0-177 的口径是「判得了就真判、判不了才记账」。并集是判得了的 —— 它不该出现在
// `schema_unvalidated` 里，更不该让合法调用被拒。真正判不了的（拼错的类型名、空数组）继续记账，
// 但**只记账、不执行**：记账说"不生效"，执行就不能把它判成恒假。
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

// 每个用例一个 stateDir：Core 对 stateDir 是独占的，共用会让后面的用例撞上 state_dir_owned。
const newCore = async () => {
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(mkdtempSync(join(tmpdir(), 'tss-r0179-')), 'state') });
  core.log = () => {};
  return core;
};

const issuesOf = (core, id) => core._capabilities.get(id)?.schema_unvalidated || [];

export default async function (runner) {
  runner.test('R0-179 属性并集 [integer,null]：5 / -3 / null 放行，\'x\' / 1.5 / true 拒绝', async () => {
    const core = await newCore();
    core.registerCapability('t14.prop', {
      owner: 'test',
      handler: async (p) => ({ n: p.n }),
      input_schema: { type: 'object', required: ['n'], properties: { n: { type: ['integer', 'null'] } } },
    });
    for (const [v, want] of [[5, true], [-3, true], [null, true], ['x', false], [1.5, false], [true, false]]) {
      const r = await core.callCapability('t14.prop', { n: v });
      assertEquals(r.ok, want, `n=${JSON.stringify(v)} 期望 ok=${want}，实际 ${r.ok}（${r.error ?? r.code ?? ''}）`);
      if (!want) assertEquals(r.code, 'invalid_input', `类型不符必须具名 invalid_input，实际 ${r.code}`);
    }
    assertEquals(issuesOf(core, 't14.prop').length, 0,
      `并集是判得了的，不得记成未生效，实际 ${JSON.stringify(issuesOf(core, 't14.prop'))}`);
  });

  runner.test('R0-179 根并集 [object,null]：{} 与 null 放行，\'x\' 拒绝，且不重复记账', async () => {
    const core = await newCore();
    core.registerCapability('t14.root', {
      owner: 'test',
      handler: async (p) => p,
      input_schema: { type: ['object', 'null'], properties: { a: { type: 'string' } } },
    });
    for (const [v, want] of [[{}, true], [{ a: 'hi' }, true], [null, true], ['x', false], [7, false]]) {
      const r = await core.callCapability('t14.root', v);
      assertEquals(r.ok, want, `params=${JSON.stringify(v)} 期望 ok=${want}，实际 ${r.ok}（${r.error ?? r.code ?? ''}）`);
    }
    assertEquals(issuesOf(core, 't14.root').length, 0,
      `根并集包含 object，不该再记冲突，实际 ${JSON.stringify(issuesOf(core, 't14.root'))}`);
  });

  runner.test('R0-179 判不了的类型：登记成功、只记一条、且**不**用它把调用判成恒假', async () => {
    const core = await newCore();
    const warns = [];
    core.log = (level, msg) => { if (level === 'warn') warns.push(String(msg)); };
    core.registerCapability('t14.bad', {
      owner: 'test',
      handler: async (p) => ({ n: p.n }),
      input_schema: { type: 'object', properties: { n: { type: 'not-a-type' } } },
    });
    const issues = issuesOf(core, 't14.bad');
    assertEquals(issues.length, 1, `只该记一条（拼错的类型名），实际 ${JSON.stringify(issues)}`);
    assertEquals(issues[0].path, '$.properties.n.type', '记账必须指到出错的那一处');
    assertEquals(issues[0].assertional, true, '它会改变准入结论（不再判），必须标成 assertional');
    assert(warns.some((w) => /\[schema\]/.test(w) && /能改变准入结论/.test(w)),
      `告警必须说明它会影响准入结论，实际 ${JSON.stringify(warns)}`);
    const r = await core.callCapability('t14.bad', { n: 123 });
    assertEquals(r.ok, true, `记账说“不生效”，执行就不能把它判成恒假（实际 ${r.error ?? r.code}）`);
  });

  runner.test('R0-179 根类型写错 + 结构化契约：只记一条，不因两条规则各记一遍', async () => {
    const core = await newCore();
    core.registerCapability('t14.dupe', {
      owner: 'test',
      handler: async () => 'ok',
      input_schema: { type: ['strng', 'object'], properties: { a: { type: 'string' } } },
    });
    const issues = issuesOf(core, 't14.dupe');
    assertEquals(issues.length, 1, `同一处声明只该记一条，实际 ${JSON.stringify(issues)}`);
    assertEquals(issues[0].path, '$.type', `应指到 $.type，实际 ${issues[0].path}`);
    // 单元素的数组形式与字符串形式等价：仍要真判。
    core.registerCapability('t14.one', {
      owner: 'test',
      handler: async () => 'ok',
      input_schema: { type: ['object'], properties: { a: { type: ['string'] } } },
    });
    assertEquals(issuesOf(core, 't14.one').length, 0, '单元素并集在支持面内，不该记账');
    assertEquals((await core.callCapability('t14.one', { a: 1 })).ok, false, '单元素并集仍要真判');
    assertEquals((await core.callCapability('t14.one', { a: 's' })).ok, true, '合法入参不得被拦');
  });

  runner.test('R0-179 回归：根 type 与结构化契约冲突仍只记一条，普通 type 照旧真判', async () => {
    const core = await newCore();
    core.registerCapability('t14.conflict', {
      owner: 'test',
      handler: async () => 'ok',
      input_schema: { type: 'string', properties: { a: { type: 'string' } } },
    });
    const issues = issuesOf(core, 't14.conflict');
    assertEquals(issues.length, 1, `冲突只该记一条，实际 ${JSON.stringify(issues)}`);
    assertEquals(issues[0].path, '$', `冲突应记在 $，实际 ${issues[0].path}`);
    core.registerCapability('t14.plain', {
      owner: 'test',
      handler: async () => 'ok',
      input_schema: { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } },
    });
    assertEquals((await core.callCapability('t14.plain', { a: 1 })).ok, true, '合法入参必须放行');
    assertEquals((await core.callCapability('t14.plain', 'x')).ok, false, '根类型声明必须真判');
    assertEquals((await core.callCapability('t14.plain', { a: '1' })).ok, false, '属性 integer 必须真判');
  });
}
