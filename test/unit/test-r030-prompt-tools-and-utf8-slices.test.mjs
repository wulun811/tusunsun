// R0-030（rc.15）：同形判据与字符边界（专家 rc.14 复审 M3 / M4）。
//
// M3：`prompt-builder` 里两条"看工具名"的判据写法不一致 —— `_injectWorkspace` 用 `t.name || t`，
//     `_injectSafetyReflection` 直接 `RegExp.test(t)`。真实调用面上 `ctx.tools` 是**对象**
//     （`{name:'tool-write', ...}`），对对象做 `test` 会先 ToString 成 `"[object Object]"`，
//     永远不匹配。于是 `tools.safetyReflection` 承诺的"写文件/执行命令前先自检"在真实部署里
//     恒等于关闭，而开关看起来是开着的。
//
// M4：`context.pull` 的 `charBudget` 是**字节**预算，`buf.subarray(start, start + charBudget)`
//     会切在多字节字符中间。`toString('utf8')` 于是产出 U+FFFD，而且 `byte_range.to` 与
//     `next_offset_bytes` 把损坏位置**固化成续读起点** —— 每段开头带 `�`，拼接起来永远
//     拼不回原文；`sha256` 覆盖的是损坏后的字节，逐段校验会把正确文件判成不一致。
//
// 本文件钉住：
//   /1  对象形态的工具必须触发安全反思段（与字符串形态同形）——修前对象形态恒不触发
//   /2  结构判据：8 个真实工具名 × 两种形态，触发结果必须逐一相同
//   /3  中文文件在任何预算下都不得产出 U+FFFD，且 `to` / `next_offset_bytes` 落在字符边界
//   /4  续读拼接必须等于原文（无丢字、无重复、无替换符）
//   /5  反向判据：ASCII 文件不因边界回退而少给（仍按预算取满）
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const CONTINUATION = (b) => b !== undefined && (b & 0xC0) === 0x80;

export async function setup(runner) {
  const { default: promptSingleton } = await imp('plugins/prompt-builder.js');
  const PromptProto = Object.getPrototypeOf(promptSingleton);
  const { LocalManifestProvider } = await imp('plugins/_lib/context/providers/local-manifest.js');

  /** 造一个只够 `_injectSafetyReflection` 跑的宿主。 */
  function builder(flags = {}) {
    const p = Object.create(PromptProto);
    p.core = { get: (k, dflt) => (Object.hasOwn(flags, k) ? flags[k] : dflt) };
    return p;
  }

  /** 在一个临时授权根里放一份正文与 manifest。 */
  async function withProvider(body, fn) {
    const root = mkdtempSync(join(tmpdir(), 'r030-'));
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      writeFileSync(join(root, 'docs', 'note.md'), body);
      writeFileSync(join(root, '.context-manifest.json'), JSON.stringify({
        schema_version: 'tusunsun.context-manifest/v0',
        items: [{ ref: 'context:note', title: 'note', type: 'doc', source: 'docs/note.md', brief: 'b' }],
      }));
      const provider = new LocalManifestProvider({ resourceRoot: root });
      return await fn({ provider, buf: Buffer.from(body, 'utf8') });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // ══ M3 主干：对象形态的工具必须与字符串形态同形 ═════════════════════
  runner.test('R0-030/1 对象形态的写工具必须触发安全反思段（修前恒不触发）', async () => {
    const asObject = builder();
    const ctxObj = { sessionId: 's', tools: [{ name: 'tool-write', description: 'x' }], prompt: '' };
    asObject._injectSafetyReflection(ctxObj);
    assert(/Safety Reflection/.test(ctxObj.prompt),
      '`ctx.tools` 在真实调用面上是对象，必须也能触发安全反思；实际 prompt 里没有该段'
      + '（修前用 RegExp.test(t)，对象被 ToString 成 "[object Object]" 后永不匹配）');

    const asString = builder();
    const ctxStr = { sessionId: 's', tools: ['tool-write'], prompt: '' };
    asString._injectSafetyReflection(ctxStr);
    assert(/Safety Reflection/.test(ctxStr.prompt), '字符串形态必须仍然触发');
    assertEquals(ctxObj.prompt, ctxStr.prompt,
      '两种形态必须产生完全相同的提示（同一条判据，不该有两种结果）');

    // 反向：无关工具不得触发；开关关掉时谁都不触发（判据不能变成"一律加上"）。
    const readOnly = builder();
    const ctxRead = { sessionId: 's', tools: [{ name: 'tool-read' }], prompt: '' };
    readOnly._injectSafetyReflection(ctxRead);
    assertEquals(ctxRead.prompt, '', `只读工具不该触发安全反思，实际 "${ctxRead.prompt.slice(0, 60)}"`);

    const off = builder({ 'tools.safetyReflection': false });
    const ctxOff = { sessionId: 's', tools: [{ name: 'tool-write' }], prompt: '' };
    off._injectSafetyReflection(ctxOff);
    assertEquals(ctxOff.prompt, '', '开关为 false 时必须一段都不加');
    console.log('       [实测] 对象/字符串两种形态都触发，且提示文本一致');
  });

  // ══ 结构判据：两种形态的触发集合必须逐项相等 ═════════════════════════
  runner.test('R0-030/2 结构判据：8 个真实工具名 × 对象/字符串，触发结果必须逐一相同', async () => {
    const names = ['tool-write', 'tool-bash', 'tool-rm', 'tool-mv', 'tool-read', 'tool-list', 'tool-grep', 'tool-stat'];
    const diffs = [];
    for (const n of names) {
      const a = builder();
      const ca = { sessionId: 's', tools: [{ name: n }], prompt: '' };
      a._injectSafetyReflection(ca);
      const b = builder();
      const cb = { sessionId: 's', tools: [n], prompt: '' };
      b._injectSafetyReflection(cb);
      const hitA = /Safety Reflection/.test(ca.prompt);
      const hitB = /Safety Reflection/.test(cb.prompt);
      if (hitA !== hitB) diffs.push(`${n}: 对象=${hitA} 字符串=${hitB}`);
    }
    assertEquals(diffs.length, 0,
      `同一条判据在两种工具形状上给出了不同答案：${JSON.stringify(diffs)}`
      + '（真实调用面几乎总是对象，等于这条开关在部署里恒关）');
    console.log(`       [实测] ${names.length} 个工具名两种形态结果一致`);
  });

  // ══ M4 主干：字节切片不得切断字符 ═══════════════════════════════════
  runner.test('R0-030/3 中文文件任何预算下都不得产出 U+FFFD，且两端落在字符边界', async () => {
    const body = '中'.repeat(120); // 360 字节
    await withProvider(body, async ({ provider, buf }) => {
      const bad = [];
      for (let maxTokens = 1; maxTokens <= 140; maxTokens++) {
        const r = await provider.pull('s', { ref: 'context:note', maxTokens });
        if (r.text.includes('\uFFFD')) bad.push({ maxTokens, kind: 'U+FFFD', tail: r.text.slice(-3) });
        if (r.byte_range.from !== 0 && CONTINUATION(buf[r.byte_range.from])) {
          bad.push({ maxTokens, kind: 'from 落在续字节上', from: r.byte_range.from });
        }
        if (CONTINUATION(buf[r.byte_range.to])) {
          bad.push({ maxTokens, kind: 'to 落在续字节上', to: r.byte_range.to });
        }
        const h = createHash('sha256').update(Buffer.from(r.text, 'utf8')).digest('hex');
        if (r.sha256 !== h) bad.push({ maxTokens, kind: 'sha256 覆盖的不是返回的字节' });
        if (bad.length >= 4) break;
      }
      assertEquals(bad.length, 0,
        `字节切片切断了多字节字符：${JSON.stringify(bad.slice(0, 4))}。`
        + '切点必须退回到字符边界，且 sha256 覆盖的必须是真正返回的那段字节');
      console.log('       [实测] 扫 140 个预算值，0 个替换符、0 个越界切点、哈希自洽');
    });
  });

  // ══ M4 后果：续读必须能拼回原文 ═════════════════════════════════════
  runner.test('R0-030/4 续读拼接必须等于原文（无丢字、无重复、无替换符）', async () => {
    const body = `开头-${'中文内容'.repeat(40)}-结尾`;
    await withProvider(body, async ({ provider }) => {
      const parts = [];
      let offset = 0;
      let guard = 0;
      for (;;) {
        if (++guard > 200) { assert(false, '续读没有推进（next_offset_bytes 不前进）'); }
        const r = await provider.pull('s', { ref: 'context:note', maxTokens: 40, offsetBytes: offset });
        assert(!r.text.includes('\uFFFD'), `第 ${parts.length + 1} 段含替换符：${JSON.stringify(r.text.slice(0, 8))}`);
        parts.push(r.text);
        if (!r.truncated) break;
        assertEquals(typeof r.next_offset_bytes, 'number', '截断时必须给出 next_offset_bytes');
        assert(r.next_offset_bytes > offset, `next_offset_bytes 必须前进（${offset} → ${r.next_offset_bytes}）`);
        offset = r.next_offset_bytes;
      }
      assertEquals(parts.join(''), body,
        `逐段拼接必须等于原文；实际 ${parts.join('').length} 字符 vs 原文 ${body.length} 字符`
        + '（分段开头带替换符时，拼出来的东西永远修不回原文）');
      console.log(`       [实测] ${parts.length} 段拼回原文（${body.length} 字符）`);
    });
  });

  // ══ M4 反向：不许用"少给"来换安全 ═════════════════════════════════
  runner.test('R0-030/5 反向判据：ASCII 文件仍按预算取满（边界回退不得变成缩水）', async () => {
    const body = 'a'.repeat(1000);
    await withProvider(body, async ({ provider }) => {
      const r = await provider.pull('s', { ref: 'context:note', maxTokens: 100 });
      assertEquals(r.byte_range.from, 0, '从 0 开始');
      assertEquals(r.byte_range.to - r.byte_range.from, 150,
        `ASCII 每个字节都是字符边界，必须按预算取满 150 字节，实际 ${r.byte_range.to - r.byte_range.from}`);
      assertEquals(r.next_offset_bytes, 150, `继续读的位置应是 150，实际 ${r.next_offset_bytes}`);
      assertEquals(r.truncated, true, '1000 字节的文件在 150 字节预算下必须是"节选"');
      console.log('       [实测] ASCII 取满 150 字节，未因边界回退缩水');
    });
  });
}
