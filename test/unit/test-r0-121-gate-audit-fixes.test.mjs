// R0-121：0.9.12 上线前复查 —— 对抗式自查发现的真阳性，全部先实测复现再修
//
//   T1 目标聚合：`rm -r d1 && truncate -s 0 a.js` 只测到最后一段 ⇒ 16 个文件只报 1
//   T2 覆盖重定向：`echo x > main.js` 的目标从不提取 ⇒ 挑战里赫然写"实测 0 个文件"
//   T3 静态算不准：`**`/父目录通配/字符类/变量 被当一层展开或字面路径 ⇒ 一律少报
//   T4 判据缺口：`git checkout -- <路径>` / `truncate -s 100` / `2>` / `>|` 全部漏判
//   T5 活锁防线：拒绝后不带 ack 原样重发即领新挑战 ⇒ MAX_ATTEMPTS 形同虚设
//   T6 失败的读：读超时/抛错的文件也被记"已读" ⇒ 写前必读被绕过
//   T7 误伤回归：本轮所有扩大判据不得让日常命令进软闸
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const imp = (rel) => import(join(ROOT, rel));

/** 与 test-r0-119 同款最小执行器：config 走 stub，能力处理器转发到 `_tools`。 */
async function makeExecutor({ workDir }) {
  const { Core } = await imp('src/core/core.js');
  const ToolExecutor = (await imp('plugins/tool-executor.js')).default;
  const core = new Core();
  if (workDir) core.setData('agent.workDir', workDir);
  const cfg = new Map();
  core.registerService('config', {
    get: (k, fb) => (cfg.has(k) ? cfg.get(k) : fb),
    set: (k, v) => { cfg.set(k, v); return true; },
  });
  const ex = Object.create(ToolExecutor);
  Object.assign(ex, {
    core, _tools: new Map(), _aliases: new Map(), _preHooks: [], _postHooks: [],
    _metrics: new Map(), _auditLog: new Map(), _cache: new Map(), _cacheOrder: [],
    _preferences: new Map(), _rateCalls: new Map(), _maxParallel: 2, _useSandbox: false,
  });
  core.registerService('tool-executor', ex);
  const route = (cap, tool) => core.registerCapability(cap, {
    description: 'x', owner: tool,
    handler: async (args) => {
      const t = ex._tools.get(tool);
      return t?.handler ? t.handler(args) : { ok: true, result: 'ran' };
    },
  });
  route('tool.bash', 'tool-bash');
  route('tool.read', 'tool-read');
  ex._tools.set('tool-bash', { handler: async () => ({ ok: true, result: 'ran' }) });
  ex._tools.set('tool-read', { handler: async () => ({ ok: true, result: 'content' }) });
  return { core, ex };
}

const LONG_REASON = '这些文件已全部迁到 src/kernel 并在 CI 三个 Node 版本上验证通过，旧目录仅剩过时副本';

export async function setup(runner) {
  const tmp = mkdtempSync(join(tmpdir(), 'tt-r0121-'));
  const ws = join(tmp, 'ws');
  runner.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  // T1/T2/T3 共用的固定工作区：d1 共 15 个文件（根 5 + x/ 5 + y/ 5），加三个散文件
  const buildWs = () => {
    rmSync(ws, { recursive: true, force: true });
    mkdirSync(join(ws, 'd1', 'x'), { recursive: true });
    mkdirSync(join(ws, 'd1', 'y'), { recursive: true });
    mkdirSync(join(ws, 'logs', 'sub'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(ws, 'd1', `f${i}.js`), 'x\n');
      writeFileSync(join(ws, 'd1', 'x', `g${i}.js`), 'x\n');
      writeFileSync(join(ws, 'd1', 'y', `h${i}.js`), 'x\n');
    }
    writeFileSync(join(ws, 'a.js'), 'old\n');
    writeFileSync(join(ws, 'b.js'), 'old\n');
    writeFileSync(join(ws, 'main.js'), 'old\n');
    writeFileSync(join(ws, 'err.log'), 'old\n');
    writeFileSync(join(ws, 'app.log'), 'x'.repeat(2048) + '\n');
  };

  {
    // ── T1 多段破坏命令的目标必须全部计入 ─────────────────────────────
    runner.test('R0-121/T1 目标聚合：`rm -r d1 && truncate -s 0 a.js` 不得只测最后一段', async () => {
      buildWs();
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');

      const m = measureBlastRadius('rm -r d1 && truncate -s 0 a.js', ws);
      assertEquals(m.totalFiles, 16, `实测 16 个文件（d1 15 + a.js 1），报 ${m.totalFiles} —— 多段命令只测了最后一段`);
      const raws = m.targets.map((t) => t.raw);
      assert(raws.includes('d1') && raws.includes('a.js'), `两段的目标都必须出现，实际 ${raws}`);

      const m2 = measureBlastRadius('rm a.js && rm b.js', ws);
      assertEquals(m2.totalFiles, 2, `两段 rm 各删一个文件应报 2，报 ${m2.totalFiles}`);
      console.log('       [实测] 多段命令目标全部计入：16/16、2/2（修复前分别报 1、1）');
    });

    // ── T2 覆盖重定向的目标必须提取 ───────────────────────────────────
    runner.test('R0-121/T2 覆盖重定向：`echo x > main.js` 不得给模型一个假的"0 个文件"', async () => {
      buildWs();
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');
      const { classifyIrreversible } = await imp('plugins/_lib/danger-patterns.js');

      const m = measureBlastRadius('echo new > main.js', ws);
      assertEquals(m.totalFiles, 1, `main.js 是已存在的文件，被覆盖即丢内容，应报 1，报 ${m.totalFiles}`);
      assertEquals(m.unbounded, false, '单个明确目标不该报 unbounded');

      const m2 = measureBlastRadius('cmd 2> err.log', ws);
      assertEquals(m2.totalFiles, 1, `2> 同样清空目标文件，应报 1，报 ${m2.totalFiles}`);

      // 判据：追加与 fd 复制不得误伤
      assertEquals(classifyIrreversible('echo hi >> app.log'), null, '>> 是追加，不覆盖');
      assertEquals(classifyIrreversible('cmd 2>&1 | tee x'), null, '2>&1 是 fd 复制，不产生覆盖目标');
      assert(classifyIrreversible('ls | tee x >| f'), '>| 是强制覆盖，必须命中');
      console.log('       [实测] > / 2> / >| 目标计入影响面；>> 与 2>&1 不误伤（修复前报 0 并要求复述 0）');
    });

    // ── T3 静态算不准的必须报 unbounded，不许拿少报的数字冒充 ──────────
    runner.test('R0-121/T3 影响面诚实性：算不准就报 unbounded，绝不少报一个看起来精确的数', async () => {
      buildWs();
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');
      const cases = [
        ['rm -r **/*.log', '递归通配 **：文件头注释承诺"宁可报 unbounded"，旧代码却当一层展开'],
        ['rm logs/*/b.log', '父目录带通配：一层展开覆盖不了，旧代码 stat 字面路径报 0'],
        ['rm [ab].js', 'shell 字符类：匹配器不支持，旧代码当字面路径报 0'],
        ['rm $TARGET', '变量目标：值运行时才知道，任何静态数字都是编的'],
      ];
      for (const [cmd, why] of cases) {
        const m = measureBlastRadius(cmd, ws);
        assertEquals(m.unbounded, true, `${cmd} 必须报 unbounded（${why}），实际 files=${m.totalFiles}`);
      }
      // 确定的范围仍然必须给确定数（不许因噎废食全报 unbounded）
      const exact = measureBlastRadius('rm *.js', ws);
      assertEquals(exact.unbounded, false, '一层通配可以精确展开，不该偷懒报 unbounded');
      assertEquals(exact.totalFiles, 3, `a.js/b.js/main.js 三个，报 ${exact.totalFiles}`);
      console.log('       [实测] **/父目录通配/字符类/变量 → unbounded；一层通配仍精确计数');
    });

    // ── T4 判据缺口 ───────────────────────────────────────────────────
    runner.test('R0-121/T4 判据缺口：git checkout -- 路径 / truncate -s N 不得漏判', async () => {
      const { classifyIrreversible } = await imp('plugins/_lib/danger-patterns.js');
      const missed = [
        'git checkout -- main.js',
        'git checkout HEAD~2 -- src/core.js',
        'truncate -s 100 app.log',
        'cmd 2> err.log',
      ];
      for (const c of missed) {
        assert(classifyIrreversible(c), `漏判：${c}（丢弃工作区改动/收缩文件，均不可恢复）`);
      }
      const mustPass = ['git checkout -b feat', 'git checkout main', 'truncate -s +100 app.log'];
      for (const c of mustPass) {
        assertEquals(classifyIrreversible(c), null, `误伤：${c} → ${classifyIrreversible(c)?.id}`);
      }
      console.log('       [实测] checkout -- 路径 / truncate -s N / 2> 全部识别；-b、切分支、+N 追加不误伤');
    });

    // ── T5 拒绝必须粘住，MAX_ATTEMPTS 不许被"去掉 ack 重发"清零 ────────
    runner.test('R0-121/T5 活锁防线：复述失败 3 次后，不带 ack 原样重发不得领到新挑战', async () => {
      buildWs();
      const { ex } = await makeExecutor({ workDir: ws });
      const cmd = 'rm -r d1';

      // 首发领挑战
      const c1 = await ex.executeOne('tool-bash', { command: cmd }, 's1', 'c1');
      assertEquals(c1.status, 'needs_reasoning', '首次应给出挑战');

      // 错两次 → 中间穿插一次"不带 ack 的原样重发"（旧实现会把 attempts 清零）→ 再错一次
      const wrongAck = { reason: LONG_REASON, files: 999, scope: 'inside' };
      await ex.executeOne('tool-bash', { command: cmd, danger_ack: wrongAck }, 's1', 'c1');
      await ex.executeOne('tool-bash', { command: cmd, danger_ack: wrongAck }, 's1', 'c1');
      const resend = await ex.executeOne('tool-bash', { command: cmd }, 's1', 'c1');
      assertEquals(resend.status, 'needs_reasoning', '未到上限的重发仍应给挑战（带纠正提示）');
      const third = await ex.executeOne('tool-bash', { command: cmd, danger_ack: wrongAck }, 's1', 'c1');
      assertEquals(third.status, 'blocked', `穿插重发不得清零失败计数：第 3 次复述失败应拒绝，实际 ${third.status}`);

      // 拒绝之后：不带 ack 原样重发 → 必须维持拒绝（旧实现会发全新挑战，无限续命）
      const after = await ex.executeOne('tool-bash', { command: cmd }, 's1', 'c1');
      assertEquals(after.status, 'blocked', `拒绝要粘住：TTL 内同一条命令不得再领挑战，实际 ${after.status}`);

      // 换命令（指纹不同）不受影响
      const other = await ex.executeOne('tool-bash', { command: 'rm -r logs' }, 's1', 'c1');
      assertEquals(other.status, 'needs_reasoning', '别的命令是新的指纹，必须照常给挑战');
      console.log('       [实测] 复述失败 3 次 → 拒绝并粘住；不带 ack 重发不能清零；换命令不受牵连');
    });

    // ── T6 失败的读不得记"已读" ────────────────────────────────────────
    runner.test('R0-121/T6 写前必读：读抛错/超时的文件不得获得"已读"资格', async () => {
      buildWs();
      const { ex, core } = await makeExecutor({ workDir: ws });
      const Kx = (await imp('plugins/kunxiansuo-local.js')).default;
      await Kx.init(core);
      const target = join(ws, 'main.js');

      // ① handler 抛错 → 执行走失败路径（posthook 收到 ok=false）→ 不得记已读
      ex._tools.set('tool-read', { handler: async () => { throw new Error('boom'); } });
      await ex.executeOne('tool-read', { path: target }, 's1', 'c1').catch(() => {});
      const blocked = await ex._checkPreFlight('tool-write', { path: target }, 's1', 'c1');
      assert(blocked, '读失败后写仍应被 WRITE_BEFORE_READ 拦住：模型没看到内容，不得获得改写资格');
      assertEquals(blocked.diagnostic.code, 'WRITE_BEFORE_READ', `判据码应为 WRITE_BEFORE_READ，实际 ${blocked.diagnostic.code}`);

      // ② 读成功 → 记已读 → 放行
      ex._tools.set('tool-read', { handler: async () => ({ ok: true, result: 'content' }) });
      await ex.executeOne('tool-read', { path: target }, 's1', 'c1');
      const allowed = await ex._checkPreFlight('tool-write', { path: target }, 's1', 'c1');
      assertEquals(allowed, null, '读成功后写必须放行');
      await Kx.stop();
      console.log('       [实测] 读失败不记已读（写仍被拦）；读成功记已读（写放行）');
    });

    // ── T7 误伤回归 ───────────────────────────────────────────────────
    runner.test('R0-121/T7 误伤回归：本轮扩大的判据不得让日常命令进软闸', async () => {
      const { classifyIrreversible } = await imp('plugins/_lib/danger-patterns.js');
      const mustPass = [
        'ls -la', 'npm test', 'git status', 'git commit -m "x"', 'node app.js',
        'cat README.md', 'grep -rn TODO src/', 'npm run build', 'echo hello',
        'git checkout main', 'git checkout -b feat', 'echo hi >> app.log',
        'cmd 2>&1 | tee x', 'grep -rn ">" src/', 'echo a->b', 'git log --oneline',
        'node --eval "console.log(1)"', 'awk "{print \$1}" f.txt',
      ];
      const fp = mustPass.filter((c) => classifyIrreversible(c));
      assertEquals(fp.length, 0, `日常命令被软闸拦：${fp.map((c) => `${c} → ${classifyIrreversible(c).id}`).join('; ')}`);
      console.log(`       [实测] ${mustPass.length} 条日常命令零误伤`);
    });

    // ── T8 版本与文档一致性 ───────────────────────────────────────────
    runner.test('R0-121/T8 一致性：package.json 的版本与描述不得与实况矛盾', async () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      // v0.10.0：正则从 `^0\.9\.\d+$` 放宽。它原先把"版本号"钉成了"0.9 系列"，
      // 而 0.10.0 是合法演进（语义化版本里 minor 可以到两位数）。
      // 这条判据的本意是"版本号必须存在且形状正常"，不是"必须叫 0.9.x" ——
      // 把它写死成 0.9 会让每次升 minor 都要改门禁，而那种门禁迟早被顺手放宽成空判据。
      // R3（v0.16.0-rc.1）：再放一次，允许**语义化版本的预发布段**（`0.16.0-rc.1`）。
      // 上一版只认 `x.y.z`，于是“发一个 rc”本身就会被判成“版本号异常”——
      // 而专家的收口计划要求的就是 v0.16.0-rc。这里仍要求三数字主干 + 可选 `-pre.N`，
      // 不放行 `0.16`、`v0.16.0`、`0.16.0.1` 这类真异常形态。
      assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version), `package.json 版本号异常：${pkg.version}`);
      assert(!pkg.description.includes('2556'), `description 仍写着旧核心行数 2556：${pkg.description}`);
      const limits = readFileSync(join(ROOT, 'scripts/core-limits.mjs'), 'utf8');
      const m = limits.match(/CORE_MAX_LINES\s*=\s*(\d+)/);
      assert(m, 'core-limits.mjs 必须定义 CORE_MAX_LINES');
      assert(pkg.description.includes(m[1]),
        `description 的核心行数必须与门禁一致（${m[1]}）：${pkg.description}`);
      console.log(`       [实测] 版本 ${pkg.version}，description 与门禁 ${m[1]} 一致`);
    });

    // ── T9 长选项不得绕过两层判据 ─────────────────────────────────────
    runner.test('R0-121/T9 长选项：`rm --recursive` 既不能绕过硬拦、也不能绕过软闸', async () => {
      const { classifyIrreversible, matchDangerousCommand } = await imp('plugins/_lib/danger-patterns.js');
      for (const c of ['rm --recursive d1', 'rm --force --recursive d1', 'rm -f -r d1', 'rm --recursive=always d1']) {
        assert(matchDangerousCommand(c) || classifyIrreversible(c), `长选项/分写命令两层全漏：${c}`);
      }
      // 递归+强制（不论长短选项）都是硬拦；单纯 -f 不得升级为硬拦
      for (const c of ['rm --recursive --force /', 'rm -rf /', 'rm -fr x']) {
        assert(matchDangerousCommand(c), `递归+强制必须硬拦（Y024）：${c}`);
      }
      assertEquals(matchDangerousCommand('rm -f ./tmp.log'), null, '单纯 -f 不是递归强删，不得硬拦（应走软闸）');
      console.log('       [实测] --recursive/--force/分写短选项全部识别；-f 不升级为硬拦');
    });

    // ── T10 引号目标：剥掉配对引号，残留引号报 unbounded ────────────────
    runner.test('R0-121/T10 引号路径：`rm -r "d1"` 必须报真实文件数，不得报 0', async () => {
      buildWs();
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');
      const dq = measureBlastRadius('rm -r "d1"', ws);
      assertEquals(dq.totalFiles, 15, `双引号配对后应报 15，报 ${dq.totalFiles}（修复前报 0 并让模型复述 0）`);
      const sq = measureBlastRadius("rm -r 'd1'", ws);
      assertEquals(sq.totalFiles, 15, `单引号同理，报 ${sq.totalFiles}`);
      // 引号内含空格 ⇒ 静态切词不可信（会被切成两段），必须报 unbounded 而不是猜
      const spaced = measureBlastRadius('rm -r "my dir"', ws);
      assertEquals(spaced.unbounded, true, '带空格引号路径被切碎后必须报 unbounded，不得给出确定数');
      console.log('       [实测] "d1"/\'d1\' 均报 15；带空格的引号路径报 unbounded');
    });

    // ── T11 不可读 / 过深：算不全就必须说算不全 ────────────────────────
    runner.test('R0-121/T11 算不全要如实说：不可读子目录、超深目录不得报"确定 0"', async () => {
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');
      buildWs();

      // 40 层深的目录 + 1 个文件：深度上限内数不到，必须标截断
      let deep = 'deep';
      for (let i = 0; i < 40; i++) deep += '/x';
      mkdirSync(join(ws, deep), { recursive: true });
      writeFileSync(join(ws, deep, 'f.txt'), 'x\n');
      assertEquals(measureBlastRadius('rm -r deep', ws).unbounded, true,
        '超过深度上限的目录必须报 unbounded（修复前报 0 个文件、范围"确定"）');

      // chmod 000 的目录：读不了 ≠ 空的
      const secret = join(ws, 'secret');
      mkdirSync(secret, { recursive: true });
      writeFileSync(join(secret, 'a.js'), 'x\n');
      writeFileSync(join(secret, 'b.js'), 'x\n');
      chmodSync(secret, 0o000);
      try {
        const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
        const m = measureBlastRadius('rm -r secret', ws);
        if (isRoot) {
          console.log('       [SKIP] 以 root 运行：chmod 000 不产生 EACCES，该断言无法生效');
        } else {
          assertEquals(m.unbounded, true, '读不了的目录必须报 unbounded（修复前报 0 个文件）');
        }
      } finally {
        chmodSync(secret, 0o755);
      }
      console.log('       [实测] 超深目录与不可读目录均报 unbounded，不再用 0 冒充"确定"');
    });

    // ── T12 确认状态必须按会话隔离 ────────────────────────────────────
    runner.test('R0-121/T12 会话隔离：A 会话用尽机会，B 会话不得继承拒绝', async () => {
      buildWs();
      const { ex } = await makeExecutor({ workDir: ws });
      const cmd = 'rm -r d1';
      const bad = { reason: LONG_REASON, files: 999, scope: 'inside' };
      await ex.executeOne('tool-bash', { command: cmd }, 'sessA', 'cA');
      for (let i = 0; i < 3; i++) await ex.executeOne('tool-bash', { command: cmd, danger_ack: bad }, 'sessA', 'cA');
      const a = await ex.executeOne('tool-bash', { command: cmd }, 'sessA', 'cA');
      assertEquals(a.status, 'blocked', 'A 会话用尽 3 次机会后应拒绝');
      const b = await ex.executeOne('tool-bash', { command: cmd }, 'sessB', 'cB');
      assertEquals(b.status, 'needs_reasoning', `B 会话是独立状态，必须拿到自己的挑战，实际 ${b.status}`);
      console.log('       [实测] A 被拒不影响 B：确认状态按会话隔离');
    });

    // ── T13 关机类判据只认命令位置 ────────────────────────────────────
    runner.test('R0-121/T13 硬拦误报：把关机动词当数据（grep/man）不得硬拦，真执行必须拦', async () => {
      const { matchDangerousCommand } = await imp('plugins/_lib/danger-patterns.js');
      const mustPass = ['grep -n reboot CHANGELOG.md', 'man shutdown', 'git log --oneline | grep halt',
        'rg "poweroff" docs/'];
      for (const c of mustPass) {
        assertEquals(matchDangerousCommand(c), null, `把动词当数据被硬拦（retryable:false，无法覆盖）：${c}`);
      }
      const mustBlock = ['shutdown -h now', 'sudo reboot', 'halt; ls', 'bash -c "reboot now"', '$(poweroff)'];
      for (const c of mustBlock) {
        assert(matchDangerousCommand(c), `真正的关机/重启命令必须硬拦：${c}`);
      }
      console.log('       [实测] grep/man 里的动词不误拦；裸命令、sudo、分号后、-c 包装均拦');
    });

    // ── T14 特殊设备与读记录清理 ──────────────────────────────────────
    runner.test('R0-121/T14 影响面与读记录：/dev/null 不计入；读记录按年龄清理', async () => {
      buildWs();
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');
      const m = measureBlastRadius('truncate -s 0 app.log 2>/dev/null', ws);
      assertEquals(m.totalFiles, 1, `只有 app.log 会丢内容，/dev/null 不得计入（实际 ${m.totalFiles}）`);
      assertEquals(m.outsideWorkspace, false, '/dev/null 不得把 scope 变成 mixed');

      const { LocalFence } = await imp('plugins/_lib/kunxiansuo/local-fence.js');
      const { Core } = await imp('src/core/core.js');
      const fence = new LocalFence(new Core());
      fence.markRead('sess-x', '/tmp/read.js');
      fence._lastPrune = Date.now() - 61_000;
      fence._pruneIfNeeded();
      assertEquals(fence._readFiles.get('sess-x')?.files?.has('/tmp/read.js'), true,
        '读过不到一分钟的记录被清理了——默认配置（不限流）下每次 prune 都会误删，写入被迫重读');
      fence._readFiles.get('sess-x').at = Date.now() - 31 * 60 * 1000;
      fence._lastPrune = Date.now() - 61_000;
      fence._pruneIfNeeded();
      assertEquals(fence._readFiles.has('sess-x'), false, '超过 30 分钟的读记录应被清理');
      console.log('       [实测] /dev/null 不计入影响面；读记录 30 分钟内有效、超龄清理');
    });

    // ── T15 数据 vs 代码：引号里是文本还是会被执行的代码 ──────────────
    runner.test('R0-121/T15 数据与代码：把危险串当文本不得硬拦，喂给解释器必须拦', async () => {
      const { matchDangerousCommand, classifyIrreversible } = await imp('plugins/_lib/danger-patterns.js');

      // 数据：引号里是文本 / heredoc 体 / 提交消息 —— 此前一条不落全被硬拦（retryable:false 无覆盖）
      const data = [
        'echo "never run rm -rf /"',
        'git commit -m "fix rm -rf handling"',
        'git commit -m "fix bash -c rm -rf handling"',
        'grep -n "rm -rf" CHANGELOG.md',
        'grep -e "rm -rf" CHANGELOG.md',
        "printf '%s\\n' 'rm -rf /'",
        "cat > notes.md <<'EOF'\nrm -rf is dangerous\nEOF",
        'git commit -m "fix: 1 > 0"',
      ];
      for (const c of data) {
        assertEquals(matchDangerousCommand(c), null, `把危险串当文本被硬拦：${JSON.stringify(c)}`);
      }

      // 代码：同样的文本经解释器执行 → 必须拦（剥引号修复的代价不能是开这个口子）
      const code = [
        'bash -c "rm -rf /"',
        'echo "rm -rf /" | bash',
        'echo "$(rm -rf /)"',
        'sudo sh -c "rm -rf /"',
        'timeout 30 bash -c "rm -rf /"',
        'env -i bash -c "rm -rf /"',
        'sudo -u root bash -c "rm -rf /"',
        'ssh host "rm -rf /"',
        "bash <<'EOF'\nrm -rf /\nEOF",
        `awk 'BEGIN{system("rm -rf /")}'`,
      ];
      for (const c of code) {
        assert(matchDangerousCommand(c), `经解释器执行的命令漏拦：${JSON.stringify(c)}`);
      }

      // 软闸同一口径：提交消息里的 "rm -r" 不该触发影响面确认；真命令仍要
      assertEquals(classifyIrreversible('git commit -m "rm -r src/core"'), null,
        '提交消息里的 rm -r 只是文本，不应触发影响面确认（软闸也不该误报）');
      for (const c of ['echo "use > redirect"']) {
        assertEquals(classifyIrreversible(c), null, `引号里的 > 不是重定向：${c}`);
      }
      for (const c of ['rm -r "d1"', 'echo hi > "my file"', 'echo "rm -r" && rm -r src']) {
        assert(classifyIrreversible(c), `真实破坏动作漏判：${c}`);
      }
      console.log('       [实测] 6 条文本用例零误拦；7 条解释器执行用例零漏拦；软闸同口径');
    });
  }
}
