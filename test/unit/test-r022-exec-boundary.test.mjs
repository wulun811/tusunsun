// R0-022（rc.15）：执行面的四条边界（专家 rc.14 复审 S1 / H5 / H6 / M1）。
//
// 四条都是同一句错法的不同长相：**判据守着一个入口，实体从另一个入口落地**。
//
//   S1  打开 `sandbox.enabled` 反而**取消**了工作区边界：`_guard` 只判 deny/allow，
//       没有“必须落在工作区内”这条，而执行器一旦走沙箱，`resolveWorkspacePath`
//       一次都不跑。用户以为“开了更安全”，实际是关掉了唯一那道边界。
//
//   H5  `realpath` 对**悬空链接**只回 ENOENT，于是它被当成“普通不存在的路径段”原样
//       接上：`ws/vault -> /outside/new.txt`（目标不存在）被判“在工作区内”，
//       随后的 `writeFile` 跟随链接写到外面。判据停在链接上，效果落在链接外。
//
//   H6  auto-edit 只看第一个词，`;` `&&` `||` 换行都不在危险表里：
//       `cat a.txt; touch /tmp/x` 首词是 `cat` ⇒ 整条放行（连 confirmAction 一起绕过）。
//
//   M1  `tools.blocklist` 只在名字层判：`blocklist: ['tool-bash']` 挡不住一个别名工具，
//       因为授权看的是**能力**，而能力侧从来没有复判过黑名单。
//
// 每条都配一条反向判据：不得“一律拒绝”式假修 —— 工作区内的写、链接到内部的链接、
// 只读命令、不在黑名单的能力，都必须照旧能用。
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

export async function setup(runner) {
  const { canonicalizePhysical, canonicalizePhysicalSync } = await imp('plugins/_lib/real-path.mjs');
  const { resolveWorkspacePath } = await imp('plugins/tools/lib/workspace.mjs');
  const Sandbox = (await imp('plugins/sandbox.js')).default;
  const Tools = (await imp('plugins/tools.js')).default;
  const Exec = (await imp('plugins/tool-executor.js')).default;
  const Guard = (await imp('plugins/tool-guard.js')).default;

  let tmp;
  runner.beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'r022-')); });
  runner.afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } });

  const mkws = () => { const ws = join(tmp, 'ws'); mkdirSync(ws, { recursive: true }); return ws; };

  /** 沙箱是单例：改动它的判据集必须还原（否则后一个文件测到的不是它自己配的东西）。 */
  const withSandbox = async (setupFn, fn) => {
    const saved = {
      deny: Sandbox._deny, writeAllow: Sandbox._writeAllow,
      readAllow: Sandbox._readAllow, workDir: Sandbox._workDir, core: Sandbox.core,
    };
    try {
      setupFn();
      return await fn();
    } finally {
      Sandbox._deny = saved.deny; Sandbox._writeAllow = saved.writeAllow;
      Sandbox._readAllow = saved.readAllow; Sandbox._workDir = saved.workDir;
      Sandbox.core = saved.core;
    }
  };

  // ══ H5：悬空链接必须按**链接目标**判 ═══════════════════════════════
  runner.test('R0-022/1 悬空符号链接：目标不存在也必须出界，不得被判成“工作区内的链接”', async () => {
    const ws = mkws();
    // 链接目标在**工作区之外**且不存在 —— 正是修前放行的形状
    symlinkSync(join(tmp, 'outside-new.txt'), join(ws, 'vault'));
    const real = await canonicalizePhysical(join(ws, 'vault'));
    assertEquals(real, join(tmp, 'outside-new.txt'), `悬空链接必须解析到链接目标，实际 ${real}`);
    const err = await resolveWorkspacePath(ws, 'vault').then(() => null, (e) => e);
    assert(err && err.code === 'out_of_bounds',
      `工具层必须具名拒绝悬空链接逃逸（修前它落到“最近已存在祖先”= ws 而放行），实际 ${err?.code || '放行'}`);
    const t = Object.create(Tools);
    t.workDir = ws;
    assert(throwsSync(() => t._safePath('vault')), '同步入口（tools.js）也必须拒绝同一个悬空链接');
  });

  runner.test('R0-022/2 反向判据：普通不存在的文件仍可写（修法不得把正常的“新建”也拦了）', async () => {
    const ws = mkws();
    const p = await resolveWorkspacePath(ws, 'sub/dir/a.txt');
    assertEquals(p, join(ws, 'sub', 'dir', 'a.txt'), `不存在的新文件仍应解析成工作区内路径，实际 ${p}`);
    const t = Object.create(Tools); t.workDir = ws;
    assertEquals(t._safePath('b.txt'), join(ws, 'b.txt'), '同步入口同样不得误伤新建');
  });

  runner.test('R0-022/3 反向判据：指向工作区内部的链接仍放行', async () => {
    const ws = mkws();
    writeFileSync(join(ws, 'real.txt'), 'x');
    symlinkSync(join(ws, 'real.txt'), join(ws, 'alias.txt'));
    const p = await resolveWorkspacePath(ws, 'alias.txt');
    assert(p.endsWith('real.txt') || p.endsWith('alias.txt'), `内部链接应放行，实际 ${p}`);
    const t = Object.create(Tools); t.workDir = ws;
    assertEquals(t._safePath('alias.txt'), join(ws, 'alias.txt'), '同步入口同样应放行内部链接');
  });

  runner.test('R0-022/4 链接环必须 fail-closed，且不得挂死', async () => {
    const ws = mkws();
    symlinkSync('b', join(ws, 'a'));
    symlinkSync('a', join(ws, 'b'));
    const t0 = Date.now();
    const real = await canonicalizePhysical(join(ws, 'a'));
    const elapsed = Date.now() - t0;
    assertEquals(real, null, `链接环判不出来时必须返回 null（fail-closed），实际 ${real}`);
    assert(elapsed < 1000, `链接环不得把判据挂死（实测 ${elapsed}ms）`);
    const err = await resolveWorkspacePath(ws, 'a').then(() => null, (e) => e);
    assert(err, '链接环必须被拒绝（不得放行）');
  });

  runner.test('R0-022/5 异步与同步两份实现必须逐例一致（防“修一处漏一处”的漂移）', async () => {
    const ws = mkws();
    symlinkSync(join(tmp, 'outside-new.txt'), join(ws, 'dangling'));
    symlinkSync(join(ws, 'real.txt'), join(ws, 'inside'));
    writeFileSync(join(ws, 'real.txt'), 'x');
    symlinkSync('loop-b', join(ws, 'loop-a'));
    symlinkSync('loop-a', join(ws, 'loop-b'));
    const cases = [
      join(ws, 'plain.txt'),
      join(ws, 'sub', 'missing.txt'),
      join(ws, 'dangling'),
      join(ws, 'inside'),
      join(ws, 'loop-a'),
      join(ws, 'sub', '..', 'x.txt'),
      join(ws, 'does-not-exist', '..', 'x.txt'),
    ];
    for (const p of cases) {
      // eslint-disable-next-line no-await-in-loop
      const a = await canonicalizePhysical(p);
      let b = null; let bThrew = false;
      try { b = canonicalizePhysicalSync(p); } catch { bThrew = true; }
      if (a === null) assert(b === null || bThrew, `异步判 null、同步却给了 ${b}：${p}`);
      else assertEquals(b, a, `同一路径两份实现结论不同（异步 ${a} / 同步 ${b}）：${p}`);
    }
  });

  // ══ S1：开沙箱不得取消工作区边界 ═════════════════════════════════
  runner.test('R0-022/6 开沙箱后绝对路径与 ../ 都必须出界（修前两者都成功）', async () => {
    const ws = mkws();
    await withSandbox(() => {
      Sandbox._deny = []; Sandbox._writeAllow = []; Sandbox._readAllow = []; Sandbox._workDir = ws;
    }, async () => {
      const abs = await Sandbox._guard('write', { path: join(tmp, 'OUTSIDE.txt') });
      assertEquals(abs.ok, false, '沙箱必须拒绝工作区外的绝对路径');
      assertEquals(abs.code, 'sandbox_outside_workspace', `拒绝理由必须具名，实际 ${abs.code}`);
      const dotdot = await Sandbox._guard('write', { path: '../OUTSIDE.txt' });
      assertEquals(dotdot.ok, false, '沙箱必须拒绝 ../ 逃逸');
    });
  });

  runner.test('R0-022/7 反向判据：工作区内照常、显式 writeAllow 放宽照常', async () => {
    const ws = mkws();
    await withSandbox(() => {
      Sandbox._deny = []; Sandbox._writeAllow = []; Sandbox._readAllow = []; Sandbox._workDir = ws;
    }, async () => {
      const rel = await Sandbox._guard('write', { path: 'a.txt' });
      assertEquals(rel.ok, true, '工作区内的相对路径必须放行');
      // 放行时必须回传**物理**路径（判据与效果同一位置）；修前回的是 `path`，修后是 `paths`
      assertEquals(rel.paths?.path ?? rel.path, join(ws, 'a.txt'), '放行时必须回传物理路径');
      const abs = await Sandbox._guard('write', { path: join(ws, 'b.txt') });
      assertEquals(abs.ok, true, '工作区内的绝对路径也必须放行');
    });
    await withSandbox(() => {
      Sandbox._deny = []; Sandbox._writeAllow = [tmp]; Sandbox._readAllow = []; Sandbox._workDir = ws;
    }, async () => {
      const widen = await Sandbox._guard('write', { path: join(tmp, 'OUTSIDE.txt') });
      assertEquals(widen.ok, true, '显式写进 writeAllow 的目录是用户主动放宽的那一份，必须仍然生效');
    });
  });

  runner.test('R0-022/8 cp / mv / rm 也必须过路径判据（修前这三个 op 连判据都没有）', async () => {
    const ws = mkws();
    await withSandbox(() => {
      Sandbox._deny = []; Sandbox._writeAllow = []; Sandbox._readAllow = []; Sandbox._workDir = ws;
    }, async () => {
      const cp = await Sandbox._guard('cp', { src: join(tmp, 'OUTSIDE.txt'), dest: join(ws, 'in.txt') });
      assertEquals(cp.ok, false, 'cp 的源在工作区外必须拒（修前它连判据都没进）');
      const mv = await Sandbox._guard('mv', { src: join(ws, 'a.txt'), dest: join(tmp, 'OUTSIDE.txt') });
      assertEquals(mv.ok, false, 'mv 的目标在工作区外必须拒');
      const rm = await Sandbox._guard('rm', { path: join(tmp, 'OUTSIDE.txt') });
      assertEquals(rm.ok, false, 'rm 的工作区外目标必须拒');
      const cpIn = await Sandbox._guard('cp', { src: join(ws, 'a.txt'), dest: join(ws, 'b.txt') });
      assertEquals(cpIn.ok, true, '工作区内的 cp 必须放行（反向判据）');
      assertEquals(cpIn.paths.dest, join(ws, 'b.txt'), '放行时必须回传物理路径');
    });
  });

  // ══ H6：分隔符就是第二条命令 ════════════════════════════════════
  runner.test('R0-022/9 auto-edit 必须拦住 ; && || 换行 &（修前只认管道与重定向）', async () => {
    const blocked = [
      'cat a.txt; touch /tmp/PWNED',
      'cat a.txt && rm -rf /tmp/somedir',
      'cat a.txt || touch /tmp/PWNED',
      'cat a.txt\n touch /tmp/PWNED',
      'cat a.txt & touch /tmp/PWNED',
      'ls | grep x',
      'cat a.txt > /etc/x',
    ];
    for (const cmd of blocked) {
      const r = Exec._checkBashCommand(cmd, 'auto-edit');
      assertEquals(r.ok, false, `必须拦住：${JSON.stringify(cmd)}（实际放行）`);
    }
    // 反向判据：只读命令与非 auto-edit 档位不受影响
    for (const cmd of ['cat a.txt', 'ls -la', 'grep -n foo a.txt', 'echo "a;b"']) {
      assertEquals(Exec._checkBashCommand(cmd, 'auto-edit').ok, true, `不得误伤：${JSON.stringify(cmd)}`);
    }
    assertEquals(Exec._checkBashCommand('cat a.txt; rm -rf /', 'auto').ok, true,
      '非 auto-edit 档位不经过这张表（修法不得扩大影响面）');
  });

  // ══ M1：blocklist 必须在能力侧复判 ══════════════════════════════
  runner.test('R0-022/10 blocklist 必须按**能力**判：别名工具挡不住，能力挡得住', async () => {
    const g = Object.create(Guard);
    g.core = { emit: () => {} };
    g._allowlist = [];
    g._blocklist = ['tool-bash'];
    assertEquals(g.allowCapability('tool.bash'), false,
      'blocklist 必须在能力侧复判 —— 修前 allowlist 为空时直接 true，黑名单形同虚设');
    assertEquals(g.allowCapability('tool-bash'), false, '两种写法都必须命中');
    assertEquals(g.allowCapability('tool.read'), true, '不在黑名单里的能力不得被误伤');
    assertEquals(g.allowCapability(null), false, '目标不明仍然拒（不得因为 blocklist 有内容就放行）');
    // 反向判据：blocklist 为空时能力侧不干预；allowlist 语义不变
    g._blocklist = [];
    assertEquals(g.allowCapability('tool.bash'), true, '未配 blocklist 不得干预');
    g._allowlist = ['tool-read'];
    assertEquals(g.allowCapability('tool.read'), true, 'allowlist 的同义写法仍成立');
    assertEquals(g.allowCapability('tool.write'), false, '不在 allowlist 的能力仍然拒');
  });
}

/** 同步抛出的断言（`_safePath` 是同步入口）。 */
function throwsSync(fn) {
  try { fn(); return false; } catch { return true; }
}
