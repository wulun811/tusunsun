// AR-C06（v0.11.0 自查发现）：**同一个"目标路径"在四个地方各读一遍，取法互不相同**。
//
// 这是 AR-C05（`command` vs `_raw`）的**第二次同形出现**：
// 判据读的名字 ≠ 执行读的名字 ⇒ 判据被绕过，而它自己以为检查过了。
//
// 修前（v0.10.4）的四处取法：
//   ① `tool-write.execute`        `args.path || args.file_path || args.filePath`
//   ② 围栏 `checkBoundary`        `args.path || args.file`
//   ③ 围栏 `checkPath`（敏感路径） 只对 `write_file` / `read_file` 生效 —— `tool-write` 根本不在范围内
//   ④ 围栏「写前必读」             `args?.path`
//
// 实测（v0.10.4，真 `FileSystemGuard`，`enableBoundary: true`）：
//     checkBoundary('tool-write', {path:'/etc/passwd'})      → SYMLINK_ESCAPE（拦）
//     checkBoundary('tool-write', {file_path:'/etc/passwd'}) → **ok:true**（放）
//     checkBoundary('tool-write', {filePath:'/etc/passwd'})  → **ok:true**（放）
//     checkBoundary('tool-cp',    {src:'/etc/passwd',…})     → **ok:true**（放，一个字段都没读）
//     checkBoundary('tool-mv',    {src:'/etc/passwd',…})     → **ok:true**（放，一个字段都没读）
//
// 危害等级（诚实）：**不是可越权写**。`tool-write` 自己的 `resolveWorkspacePath` 仍会拒绝越界，
// `tool-cp`/`tool-mv` 也有 R0-113 的两端判据。丢的是**独立的一层**——
// 围栏是"就算工具自身判据写错了也还能拦"的那一层，它对这四个名字完全失明。
// 按本项目规矩：少一层防线要记，但不得说成"能越界"。
//
// 修法：字段清单**只有一份**（`plugins/_lib/tool-path-args.mjs`），
// 四处取路径都问它。新增别名只改一处，漏改由 AR-C06/6 的结构判据逐工具对照
// 工具自己声明的 `parameters` 抓出来（不靠人眼记得）。
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));
const src = (rel) => readFileSync(join(ROOT, rel), 'utf-8');

/** 真 FileSystemGuard（只测判据本身，不掺执行器）。 */
async function makeGuard() {
  const { FileSystemGuard } = await imp('plugins/_lib/kunxiansuo/file-guard.js');
  return new FileSystemGuard({ enableBoundary: true, safeRoots: [process.cwd(), '/tmp'] });
}

/** 真 Core + 真执行器 + 真 tool-write + 真护栏（用于端到端与写前必读）。 */
async function makeHost() {
  const d = mkdtempSync(join(tmpdir(), 'arc06-'));
  const ws = join(d, 'ws');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(ws, { recursive: true });
  const { Core } = await imp('src/core/core.js');
  const core = new Core({ stateDir: join(d, 'state') });
  core.log = () => {};
  core.setData('agent.workDir', ws);

  const T = (await imp('plugins/tool-executor.js')).default;
  const ex = Object.create(T);
  ex._preHooks = []; ex._postHooks = []; ex._dispatchHooks = [];
  ex._rateCalls = new Map(); ex._cache = new Map(); ex._auditLog = new Map();
  ex._receipts = new Map(); ex._receiptMax = 100;
  ex._metrics = new Map(); ex._preferences = new Map(); ex._debugStream = null;
  ex._maxParallel = 5; ex._timeout = 30000;
  ex.core = core;
  await ex.init(core);

  const W = (await imp('plugins/tools/tool-write.js')).default;
  const write = Object.create(W);
  write.core = core;
  await write.init(core);
  core.registerService('tool-registry', {
    get: async (n) => (n === 'tool-write' ? write : null),
    has: (n) => n === 'tool-write',
    listTools: () => [],
  });

  // 真护栏接线（与生产同一条路径：kunxiansuo-local 自己 setFence）
  const Kx = (await imp('plugins/kunxiansuo-local.js')).default;
  await Kx.init(core);

  const stop = async () => {
    try { await Kx.stop(); } catch { /* 停不掉不影响断言结论 */ }
    try { await ex.stop(); } catch { /* 同上 */ }
  };
  return { d, ws, core, ex, write, stop };
}

export async function setup(runner) {
  // ══ AR-C06/1：走**模型真实入口**，`file_path` 别名不得成为边界旁路 ═════════════
  runner.test('AR-C06/1 executeBatch 传 {file_path:"/etc/passwd"} 必须被拒且零副作用', async () => {
    const h = await makeHost();
    try {
      const before = readFileSync('/etc/passwd', 'utf-8');
      const res = await h.ex.executeBatch(
        [{ id: 'c1', name: 'tool-write', arguments: JSON.stringify({ file_path: '/etc/passwd', content: 'PWNED\n' }) }],
        { sessionId: 'sess-A', chainId: 'c1' },
      );
      const r = res[0];
      assert(r.state !== 'succeeded',
        `file_path 别名不得绕过边界判据 —— v0.10.4 围栏只读 args.path，`
        + `而 tool-write 认 file_path，实际 state=${r.state}`);
      assertEquals(readFileSync('/etc/passwd', 'utf-8'), before,
        '/etc/passwd 必须一字节未变');
      console.log(`       [实测] state=${r.state} code=${r.code ?? r.diagnostic?.code ?? '-'}，/etc/passwd 未变`);
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C06/2：三个别名在围栏判据里必须等价 ═══════════════════════════════════
  runner.test('AR-C06/2 围栏：path / file_path / filePath 三种写法结论一致', async () => {
    const g = await makeGuard();
    for (const field of ['path', 'file_path', 'filePath', 'file']) {
      const r = g.checkBoundary('tool-write', { [field]: '/etc/passwd' });
      assertEquals(r.ok, false,
        `围栏必须拦住 {${field}:'/etc/passwd'} —— 修前 file_path/filePath 被放行（只读 args.path|args.file）`);
      assertEquals(r.field, field, `拒绝理由应点名是哪个字段越界，实际 ${r.field}`);
    }
    // 反例：工作区内路径不得被误伤
    const inside = g.checkBoundary('tool-write', { file_path: '/tmp/arc06-inside.txt' });
    assertEquals(inside.ok, true, '工作区内的 file_path 不得被误拦（/tmp 在 safeRoots 里）');
    console.log('       [实测] 四个别名一律拦，区内 file_path 放行');
  });

  // ══ AR-C06/3：cp / mv 的**两端**都要查 ═══════════════════════════════════════
  //
  // 这一条单独写，因为修前它们一个字段都没读（`checkBoundary` 只取 path|file）。
  // "只查一端"是最容易犯的错：src 在区内、dest 在区外，文件就被搬出去了。
  runner.test('AR-C06/3 cp/mv 两端都受边界判据管辖（任一端越界即拒）', async () => {
    const g = await makeGuard();
    const cases = [
      ['tool-cp', { src: '/etc/passwd', dest: '/tmp/x.txt' }, 'src'],
      ['tool-cp', { src: '/tmp/x.txt', dest: '/etc/passwd' }, 'dest'],
      ['tool-mv', { src: '/etc/passwd', dest: '/tmp/x.txt' }, 'src'],
      ['tool-mv', { src: '/tmp/x.txt', dest: '/etc/passwd' }, 'dest'],
    ];
    for (const [tool, args, expectField] of cases) {
      const r = g.checkBoundary(tool, args);
      assertEquals(r.ok, false,
        `${tool} 的 ${expectField} 越界必须被拒 —— 修前 cp/mv 的 src/dest 从未被读过`);
      assertEquals(r.field, expectField, `应点名 ${expectField} 越界，实际 ${r.field}`);
    }
    // 反例：两端都在区内必须放行
    assertEquals(g.checkBoundary('tool-cp', { src: '/tmp/a.txt', dest: '/tmp/b.txt' }).ok, true,
      '两端都在区内不得被误拦');
    console.log('       [实测] cp/mv 的 src 与 dest 各自都能拦住');
  });

  // ══ AR-C06/4：敏感路径判据必须覆盖真正在用的写工具 ═══════════════════════════
  //
  // 修前 `checkPath` 只对 `write_file` / `read_file` 生效 —— 那两份名单里
  // `.env`、`~/.ssh/`、`/etc/` 一直在，可**真正在用的 `tool-write` 不在覆盖范围里**。
  // "名单存在、接线漏了"比"没有名单"更难发现：读代码的人会以为它在管。
  runner.test('AR-C06/4 checkPath 必须覆盖 tool-write（.env 之类）', async () => {
    const g = await makeGuard();
    const r = g.checkPath('tool-write', { path: '.env' });
    assertEquals(r.ok, false,
      'tool-write 写 .env 必须被敏感路径判据拒绝 —— 修前 checkPath 只认 write_file/read_file，'
      + 'tool-write 根本不在范围内');
    assertEquals(r.severity, 'P0', '写类工具命中敏感路径应为 P0');
    // 别名同样要覆盖
    assertEquals(g.checkPath('tool-write', { file_path: '.env' }).ok, false,
      'file_path 别名同样必须命中敏感路径判据');
    // 反例：普通文件不得被误拦
    assertEquals(g.checkPath('tool-write', { path: 'src/app.js' }).ok, true,
      '普通源文件不得被敏感路径判据误拦');
    console.log('       [实测] tool-write 写 .env 被拒（P0），普通文件放行');
  });

  // ══ AR-C06/5：写前必读也必须认别名 ═══════════════════════════════════════════
  //
  // 修前这一段读 `args?.path`。于是 `{file_path:'README.md'}` 既逃过边界判据、
  // 也逃过"改已有文件前先读"——而执行侧照写。
  runner.test('AR-C06/5 写前必读：file_path 别名同样受约束', async () => {
    const h = await makeHost();
    try {
      writeFileSync(join(h.ws, 'README.md'), '# x\n');
      const viaAlias = await h.ex._checkPreFlight('tool-write', { file_path: 'README.md' }, 's1', 'c1');
      assert(viaAlias, 'file_path 别名改写未读过的已存在文件必须被拦 —— 修前这里只读 args.path，直接放行');
      assertEquals(viaAlias.diagnostic.code, 'WRITE_BEFORE_READ',
        `判据码应为 WRITE_BEFORE_READ，实际 ${viaAlias.diagnostic.code}`);

      // 反例：新建文件（物理上不可能先读）不得被拦
      const create = await h.ex._checkPreFlight('tool-write', { file_path: 'brand-new.js' }, 's1', 'c1');
      assertEquals(create, null, '新建文件被写前必读挡住 —— 这条规则会把正常创建永久禁止');
      console.log('       [实测] file_path 改写已存在文件被拦；新建放行');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });

  // ══ AR-C06/6：**结构性**判据 + 漂移探测器 ════════════════════════════════════
  //
  // 行为判据证明不了"是哪一层在拦"（v0.10.4 的教训）。所以这里读源码钉死接线，
  // 并且**逐工具对照它自己声明的 `parameters`** —— 新增别名时漏登记，这里就红。
  runner.test('AR-C06/6 结构判据：四处取路径都走单一真相 + 字段表与工具声明一致', async () => {
    const guard = src('plugins/_lib/kunxiansuo/file-guard.js');
    const fence = src('plugins/_lib/kunxiansuo/local-fence.js');
    const tw = src('plugins/tools/tool-write.js');

    // ① 不再有硬编码的单字段读取
    assert(/pathsOf\(tool, args\)/.test(guard),
      'file-guard 的 checkBoundary / checkPath 必须用 pathsOf()，不得自己读 args.path');
    assert(!/const rawPath = args\.path \|\| args\.file/.test(guard),
      'file-guard 不得再有 `args.path || args.file` 这种单字段取法（那正是 AR-C06 的成因）');
    assert(/pickPath\(args\)/.test(fence),
      'local-fence 的写前必读必须用 pickPath()');
    assert(/pickPath\(args\)/.test(tw),
      'tool-write.execute 必须用 pickPath() —— 执行侧与判据侧必须是同一个函数');

    // ② 字段表必须覆盖每个工具自己声明的路径类参数（漂移探测器）
    const { pathFieldsOf, pathsOf, pickPath } = await imp('plugins/_lib/tool-path-args.mjs');
    const PATHISH = new Set(['path', 'file_path', 'filePath', 'file', 'src', 'dest']);
    const TOOLS = [
      ['tool-write', 'plugins/tools/tool-write.js'],
      ['tool-read', 'plugins/tools/tool-read.js'],
      ['tool-stat', 'plugins/tools/tool-stat.js'],
      ['tool-list', 'plugins/tools/tool-list.js'],
      ['tool-rm', 'plugins/tools/tool-rm.js'],
      ['tool-cp', 'plugins/tools/tool-cp.js'],
      ['tool-mv', 'plugins/tools/tool-mv.js'],
    ];
    for (const [name, rel] of TOOLS) {
      const mod = (await imp(rel)).default;
      const declared = Object.keys(mod.parameters?.properties ?? {}).filter((k) => PATHISH.has(k));
      assert(declared.length > 0, `${name} 应声明至少一个路径类参数（否则这条探测器失去意义）`);
      const mapped = new Set(pathFieldsOf(name));
      for (const k of declared) {
        assert(mapped.has(k),
          `${name} 声明了路径参数 "${k}"，但 tool-path-args.mjs 的字段表没登记它 —— `
          + '这正是 AR-C06 的成因（执行侧认、判据侧不认）。请在 PATH_FIELDS 里补上。');
      }
      // 反向：表里登记了、工具却不认的字段是死条目（同样是漂移）
      for (const k of mapped) {
        assert(PATHISH.has(k), `${name} 的字段表里有个非路径字段 "${k}"`);
      }
    }

    // ③ 取值语义：空串不算"给了"（与 `||` 的历史行为一致，但不再吞掉别名）
    assertEquals(pathsOf('tool-write', { path: '', file_path: 'a.txt' }).length, 1,
      '空串必须视为"没给"，并继续看下一个别名');
    assertEquals(pickPath({ filePath: 'b.txt' }), 'b.txt', 'pickPath 必须认 filePath');
    assertEquals(pickPath({}), null, '没有路径时 pickPath 返回 null（不是空串）');
    assertEquals(pathsOf('tool-cp', { src: 'a', dest: 'b' }).length, 2,
      'cp 必须同时返回两端（只返回一端等于给越界留一半的门）');
    console.log('       [实测] 四处接线全绿；7 个工具的声明字段与字段表双向一致');
  });

  // ══ AR-C06/7：反例 —— 修复不得误伤正常写入 ═══════════════════════════════════
  runner.test('AR-C06/7 区内正常写入（含 file_path 别名）必须成功', async () => {
    const h = await makeHost();
    try {
      const res = await h.ex.executeBatch(
        [{ id: 'c1', name: 'tool-write', arguments: JSON.stringify({ file_path: 'ok.txt', content: 'HELLO\n' }) }],
        { sessionId: 'sess-A', chainId: 'c1' },
      );
      assertEquals(res[0].state, 'succeeded',
        `区内用 file_path 别名写入必须成功 —— 修复不得把合法别名一刀切禁掉，`
        + `实际 state=${res[0].state} code=${res[0].code ?? '-'}`);
      assertEquals(existsSync(join(h.ws, 'ok.txt')), true, '文件必须真的写出来');
      assertEquals(readFileSync(join(h.ws, 'ok.txt'), 'utf-8'), 'HELLO\n', '内容必须正确');
      console.log('       [实测] 区内 file_path 写入成功，文件内容正确');
    } finally { await h.stop(); rmSync(h.d, { recursive: true, force: true }); }
  });
}
