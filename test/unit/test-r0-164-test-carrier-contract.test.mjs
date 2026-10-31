// R0-164：测试交付合同 —— 同一套断言要同时服务「源码检出」与「npm 发行包」两种载体。
//
// 背景（rc.12 专家独立审查实测）：真实制品里 5 条单测 + 1 条探针要读 `.github/workflows/*.yml`
// 与 `package-lock.json`，而这两样**按设计不进 tgz**（npm 打包硬排除），于是 ENOENT 被记成
// FAIL / 探针 rc=1。读者无法区分「Core 坏了」和「这个载体里本来就没有这个文件」。
//
// 修法不是 try/catch 吞掉 —— 那会让源码树一起假绿。改由 test/lib/carrier.mjs 判定载体：
// 发行包内把这些断言记 NOT_RUN（不折算成通过），源码检出内照旧是硬门。
// 本文件钉住**判定本身**，防的是把闸变成后门：
//   A1 `.git/` 还在、`.github/` 被删 ⇒ 仍是源码载体（删文件变不绿）
//   A2 没有 `.git/` 但还有 `.github/` 或 `package-lock.json` ⇒ 仍是源码载体
//   A3 三者都没有 ⇒ 判为发行包，且 requireRepoOnly 先正向验证「确实没有」再记 NOT_RUN
//   A4 判为发行包却带着仓库专属文件 ⇒ assertDistShape 必须抛错（显式覆盖也不例外）
//   A5 `TT_CARRIER` 显式覆盖生效；覆盖成 source 却与事实不符时必须抛错
//   A6 本树自检：该跑的跑、该 NOT_RUN 的 NOT_RUN（两种载体都必须通过）
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals, assertThrows } from '../harness.mjs';
import { detectCarrier, requireRepoOnly, assertDistShape, describeCarrier } from '../lib/carrier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 临时造一棵树：`dirs` 是相对目录（可嵌套），`files` 是留空的文件。 */
function makeTree(dirs = [], files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'r0-164-'));
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), '{}\n');
  return dir;
}

/** 临时设置/清除 TT_CARRIER —— 除 A4/A5 外，其余判据都要求默认判定可预测。 */
function withCarrierEnv(value, fn) {
  const saved = process.env.TT_CARRIER;
  if (value === undefined) delete process.env.TT_CARRIER; else process.env.TT_CARRIER = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.TT_CARRIER; else process.env.TT_CARRIER = saved;
  }
}

export async function setup(runner) {
  runner.test('R0-164/A1 删掉 .github/ 也不会把源码检出卖成发行包（.git/ 还在）', () => {
    const dir = makeTree(['.git'], ['package.json']);
    try {
      const c = withCarrierEnv(undefined, () => detectCarrier(dir));
      assertEquals(c.carrier, 'source', '含 .git/ 的树必须是源码载体（npm 永不打包 .git）');
      assertEquals(c.present.includes('.github'), false, '这棵树确实没有 .github/ —— 与发行包只差在 .git/');
      let skipped = null;
      const gate = requireRepoOnly({ noteSkip: (r) => { skipped = r; } }, dir, '源码专属判据');
      assert(gate !== null, '源码载体不该返回 null');
      assertEquals(skipped, null, '源码载体里不得记 NOT_RUN（否则删掉 .github/ 就能变绿）');
      console.log('       [实测] .git/ 存在 + 无 .github/ → source，且未记 NOT_RUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runner.test('R0-164/A2 没有 .git/ 但含 .github/ 或 package-lock.json ⇒ 仍是源码载体', () => {
    const withWf = makeTree(['.github/workflows'], ['package.json']);
    const withLock = makeTree([], ['package.json', 'package-lock.json']);
    try {
      assertEquals(withCarrierEnv(undefined, () => detectCarrier(withWf)).carrier, 'source',
        '没有 .git/ 但有 .github/ 仍是源码载体');
      assertEquals(withCarrierEnv(undefined, () => detectCarrier(withLock)).carrier, 'source',
        '只有 package-lock.json 也算源码载体');
      console.log('       [实测] 无 .git/ 时，.github/ 与 package-lock.json 各自都能把载体判成 source');
    } finally {
      rmSync(withWf, { recursive: true, force: true });
      rmSync(withLock, { recursive: true, force: true });
    }
  });

  runner.test('R0-164/A3 三者都没有 ⇒ 发行包形态，且先正向验证「确实没有」再记 NOT_RUN', () => {
    const dir = makeTree([], ['package.json']);
    try {
      const c = withCarrierEnv(undefined, () => detectCarrier(dir));
      assertEquals(c.carrier, 'dist', '无 .git/、无 .github/、无 package-lock.json 才是发行包形态');
      assertEquals(c.present.length, 0, '发行包形态下仓库专属文件必须一个都没有');
      let reason = null;
      const gate = requireRepoOnly({ noteSkip: (r) => { reason = r; } }, dir, '发布链判据');
      assertEquals(gate, null, '发行包里 requireRepoOnly 应返回 null（调用方 return）');
      assert(typeof reason === 'string' && reason.includes('NOT_RUN'),
        `发行包里必须记 NOT_RUN，实际：${reason}`);
      assert(reason.includes('发布链判据'), `NOT_RUN 原因必须点明少了哪条判据，实际：${reason}`);
      assert(reason.includes('npm 发行包'), `NOT_RUN 原因必须点明载体，实际：${reason}`);
      console.log(`       [实测] ${reason}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runner.test('R0-164/A4 判成发行包却带着仓库专属文件 ⇒ 必须抛错（覆盖标记不能洗掉事实）', () => {
    const dir = makeTree(['.github/workflows'], ['package.json']);
    try {
      // 只有显式 TT_CARRIER=dist 才能造出「判成发行包、树里却还有 .github/」这种自相矛盾的树。
      withCarrierEnv('dist', () => {
        assertEquals(detectCarrier(dir).carrier, 'dist', 'TT_CARRIER=dist 应生效（本用例故意造矛盾）');
        assertThrows(() => assertDistShape(dir), '发行包形态却带着 .github/ 必须抛错，不能假绿');
        assertThrows(() => requireRepoOnly({ noteSkip: () => {} }, dir, '任意判据'),
          'requireRepoOnly 也必须抛错（不许跳过）');
      });
      console.log('       [实测] TT_CARRIER=dist + 树里还有 .github/ → 抛错');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runner.test('R0-164/A5 TT_CARRIER 显式覆盖生效；覆盖成 source 却无对应文件必须抛错', () => {
    const empty = makeTree([], ['package.json']);
    const src = makeTree(['.git'], ['package.json']);
    try {
      assertEquals(withCarrierEnv('source', () => detectCarrier(empty)).carrier, 'source',
        'TT_CARRIER=source 应覆盖默认判定');
      assertEquals(withCarrierEnv('dist', () => detectCarrier(src)).carrier, 'dist',
        'TT_CARRIER=dist 应覆盖默认判定');
      withCarrierEnv('source', () => {
        assertThrows(() => requireRepoOnly({ noteSkip: () => {} }, empty, '任意判据'),
          'TT_CARRIER=source 但树里没有任何仓库专属文件 ⇒ 声明与事实不符，必须抛错');
      });
      console.log('       [实测] 覆盖生效；覆盖成 source 却无对应文件 → 抛错');
    } finally {
      rmSync(empty, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  runner.test('R0-164/A6 本树自检：该跑的跑、该 NOT_RUN 的 NOT_RUN', () => {
    const c = detectCarrier(ROOT);
    let reason = null;
    const gate = requireRepoOnly({ noteSkip: (r) => { reason = r; } }, ROOT, '本树自检');
    if (c.carrier === 'source') {
      assert(gate !== null, '源码检出里必须真的跑这条判据');
      assertEquals(reason, null, '源码检出里不得出现 NOT_RUN');
    } else {
      assertEquals(gate, null, '发行包里必须返回 null');
      assert(typeof reason === 'string' && reason.includes('NOT_RUN'), '发行包里必须记 NOT_RUN');
    }
    console.log(`       [实测] ${describeCarrier(ROOT)}；解析=${c.carrier}${reason ? `（${reason}）` : '（未跳过）'}`);
  });
}
