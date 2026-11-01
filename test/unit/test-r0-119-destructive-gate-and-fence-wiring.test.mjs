// R0-119：不可恢复操作软闸 + 捆仙索 local 接线
//
// 本轮修的四个缺陷都是**实测复现**的，不是推测：
//   T1 判据缺口：`rm -r src/core` / `find . -delete` / `git reset --hard` 一条硬拦都不命中
//   T2 软闸语义：确认必须复述**实测**数字，填错要被指出真实值（不是"点同意"）
//   T3 护栏接线：`kunxiansuo-local` 只注册服务、不 `setFence` ⇒ 写进场景也不生效
//   T4 护栏可用性：接线后 `WRITE_BEFORE_READ` 把新建文件永久禁止、相对路径永远比不上
//   T5 双闸冲突：软闸确认后又被 `CMD_GUARD` 拦死（"确认了也没用"）
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const imp = (rel) => import(join(ROOT, rel));
const impAbs = (abs) => import(abs);

/** 造一个最小执行器：只装 tool-executor 的空壳，工具表自己塞。 */
async function makeExecutor({ workDir }) {
  const { Core } = await imp('src/core/core.js');
  const ToolExecutor = (await imp('plugins/tool-executor.js')).default;
  const core = new Core();
  if (workDir) core.setData('agent.workDir', workDir);
  // `core.get()` 走 config 服务；这里只放一个最小 stub，用它控制 permissionMode 等开关
  const cfg = new Map();
  // 边界判据的默认根只有 cwd/tmp；macOS 的临时目录不在 /tmp 下，测试必须显式声明工作区。
  if (workDir) cfg.set('kunxiansuo.local.fsguard', { safeRoots: [workDir] });
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
  let runs = 0;
  // 能力处理器转发到 `_tools` 里的表项：这样用例可以随时替换 handler 并观察真实入参
  // （执行器走 capability 优先路径，直接把 handler 写死在能力里就看不到替换了）。
  core.registerCapability('tool.bash', {
    description: 'x', owner: 'tool-bash',
    handler: async (args) => {
      runs += 1;
      const t = ex._tools.get('tool-bash');
      return t?.handler ? t.handler(args) : { ok: true, result: 'ran' };
    },
  });
  ex._tools.set('tool-bash', { handler: async () => ({ ok: true, result: 'ran' }) });
  return { core, ex, runs: () => runs };
}

const LONG_REASON = '这些文件已全部迁到 src/kernel 并在 CI 三个 Node 版本上验证通过，旧目录仅剩过时副本';

export async function setup(runner) {
  const tmp = mkdtempSync(join(tmpdir(), 'tt-r0119-'));
  const ws = join(tmp, 'ws');
  mkdirSync(join(ws, 'src', 'core'), { recursive: true });
  for (let i = 0; i < 7; i++) writeFileSync(join(ws, 'src', 'core', `f${i}.js`), '// x\n');
  writeFileSync(join(ws, 'README.md'), '# x\n');
  // 清理必须挂在 afterAll：`setup` 只负责**注册**用例，用例在 setup 返回之后才跑。
  // 早前把 rmSync 放在 setup 的 finally 里，等于注册完就删掉工作区 ⇒ 用例全在空目录上跑。
  runner.afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  {
    // ── T1 判据缺口 ────────────────────────────────────────────────────
    runner.test('R0-119/T1 判据：日常但不可撤销的命令必须被识别（0.9.11 全部漏判）', async () => {
      const { classifyIrreversible, matchDangerousCommand } = await imp('plugins/_lib/danger-patterns.js');

      const missed = [
        'rm -r src/core', 'rm -rf ./build', 'rm *.js', 'rm src/core/core.js',
        'find . -name "*.ts" -delete', 'find . -exec rm {} \\;',
        'git reset --hard HEAD', 'git clean -fdx', 'git checkout .',
        'truncate -s 0 app.log', 'shred secrets.txt', 'echo hi > main.js', ': > main.js',
        'xargs rm',
      ];
      const notCaught = missed.filter((c) => !matchDangerousCommand(c) && !classifyIrreversible(c));
      assertEquals(notCaught.length, 0, `下列命令既不在硬拦、也不在软闸判据里：\n  ${notCaught.join('\n  ')}`);

      // 误伤面：正常命令一条都不能进软闸（否则每步都要确认，内核不可用）
      const mustPass = ['ls -la', 'npm test', 'git status', 'git commit -m "x"', 'node app.js',
        'cat README.md', 'grep -rn TODO src/', 'npm run build', 'echo hello'];
      const falsePositives = mustPass.filter((c) => classifyIrreversible(c));
      assertEquals(falsePositives.length, 0,
        `正常命令被软闸拦：${falsePositives.map((c) => `${c} → ${classifyIrreversible(c).id}`).join('; ')}`);

      // 硬拦优先是**执行器**的契约：`rm -rf /` 必须直接 Y024 拒绝，绝不能被"问一句"降级放行
      // （单独看 classifyIrreversible 会命中 rm-recursive，这没问题——顺序由执行器保证，见 T5b）
      console.log(`       [实测] ${missed.length} 条不可撤销命令全部识别，${mustPass.length} 条正常命令零误伤`);
    });

    // ── T2 影响面实测必须真实 ──────────────────────────────────────────
    runner.test('R0-119/T2 影响面：计数必须与磁盘实况一致（不是让模型自己说个数）', async () => {
      const { measureBlastRadius } = await imp('plugins/_lib/destructive-gate.js');

      const dir = measureBlastRadius('rm -r src/core', ws);
      assertEquals(dir.totalFiles, 7, `目录递归计数错误：实测 7 个文件，报 ${dir.totalFiles}`);
      assertEquals(dir.unbounded, false, '确定的目录范围不该报 unbounded');
      assertEquals(dir.outsideWorkspace, false, '工作区内不该标 outside');

      const glob = measureBlastRadius('rm *.md', ws);
      assertEquals(glob.totalFiles, 1, `通配符展开必须按真实匹配计：README.md 一个，报 ${glob.totalFiles}`);

      const outside = measureBlastRadius('rm -r ../other', ws);
      assertEquals(outside.outsideWorkspace, true, '工作区外的路径必须被标出来');

      const findCmd = measureBlastRadius('find . -name "*.md" -delete', ws);
      assertEquals(findCmd.unbounded, true,
        'find 的范围由 -name 决定，静态算不准 → 必须报 unbounded，不能拿"起点下总量"冒充删除量');

      const gitCmd = measureBlastRadius('git reset --hard HEAD', ws);
      assertEquals(gitCmd.unbounded, true, 'git 的范围由仓库状态决定 → 必须报 unbounded');
      console.log('       [实测] 目录/通配符按真实匹配计数；find/git 如实报 unbounded（不冒充精确）');
    });

    // ── T2b 确认必须复述数字，填错要点出真实值 ─────────────────────────
    runner.test('R0-119/T2b 软闸：不确认不执行；数字填错要回显实测值；填对才执行', async () => {
      const { ex, runs } = await makeExecutor({ workDir: ws });

      const first = await ex.executeOne('tool-bash', { command: 'rm -r src/core' }, 's1', 'c1');
      assertEquals(first.status, 'needs_reasoning', `首次必须给出挑战而不是执行，实际 ${first.status}`);
      assertEquals(first.diagnostic.code, 'Y025', `挑战必须带具名 code Y025，实际 ${first.diagnostic.code}`);
      assertEquals(runs(), 0, '未确认前 handler 绝不允许执行（副作用不得发生）');
      assert(Array.isArray(first.challenge?.questions) && first.challenge.questions.length >= 3,
        '挑战必须列出要回答的问题（必要吗/范围多大/可恢复吗/影响面）');
      assertEquals(typeof first.challenge.measured.files, 'number', '挑战必须给出**实测**文件数');

      const wrong = await ex.executeOne('tool-bash', {
        command: 'rm -r src/core',
        danger_ack: { reason: LONG_REASON, files: 999, scope: 'inside' },
      }, 's1', 'c1');
      assertEquals(wrong.status, 'needs_reasoning', '数字对不上时不得执行');
      assert(/实测 7/.test(wrong.error), `必须回显实测值 7，实际：${wrong.error}`);
      assertEquals(runs(), 0, '数字对不上时 handler 不得执行');

      const vague = await ex.executeOne('tool-bash', {
        command: 'rm -r src/core',
        danger_ack: { reason: '删', files: 7, scope: 'inside' },
      }, 's1', 'c1');
      assert(/至少 24/.test(vague.error), `理由过短必须被拒（复述命令不算理由），实际：${vague.error}`);

      const ok = await ex.executeOne('tool-bash', {
        command: 'rm -r src/core',
        danger_ack: { reason: LONG_REASON, files: 7, scope: 'inside' },
      }, 's1', 'c1');
      assertEquals(runs(), 1, '确认无误后必须真的执行');
      assertEquals(ok.status, undefined, '执行成功时不应带 blocked 状态');
      console.log('       [实测] 不确认不执行 → 数字错回显实测 7 → 理由过短被拒 → 填对执行');
    });

    // ── T2c full-auto / 普通命令不受影响 ───────────────────────────────
    runner.test('R0-119/T2c 边界：full-auto 是用户显式选择（不打断）；tool-rm 走回收站（不问）', async () => {
      const { ex, core, runs } = await makeExecutor({ workDir: ws });
      core.getService('config').set('tools.permissionMode', 'full-auto');
      await ex.executeOne('tool-bash', { command: 'rm -r src/core' }, 's1', 'c1');
      assertEquals(runs(), 1, 'full-auto 是用户显式选择"不要打断"，软闸不得绕过该设置');

      const { ex: ex2, runs: runs2 } = await makeExecutor({ workDir: ws });
      await ex2.executeOne('tool-bash', { command: 'ls -la' }, 's1', 'c1');
      assertEquals(runs2(), 1, '普通命令必须直通，不得因为软闸存在而多付一轮');

      const { ex: ex3, runs: runs3 } = await makeExecutor({ workDir: ws });
      ex3._tools.set('tool-rm', { handler: async () => { return { ok: true, trashed: '/t/x' }; } });
      const r = await ex3.executeOne('tool-rm', { path: 'README.md' }, 's1', 'c1');
      assert(!r || r.status !== 'needs_reasoning',
        'tool-rm 进回收站（可恢复），不该被"不可恢复操作"软闸拦——否则最安全的删除方式反而最难用');
      void runs3;
      console.log('       [实测] full-auto 不打断、普通命令直通、tool-rm 不受软闸约束');
    });

    // ── T2d 确认字段不得漏进工具参数 ───────────────────────────────────
    runner.test('R0-119/T2d 确认字段必须在执行前剥掉（tool-bash 只认 command，多字段会炸 schema）', async () => {
      const { ex } = await makeExecutor({ workDir: ws });
      let captured = null;
      ex._tools.set('tool-bash', { handler: async (args) => { captured = args; return { ok: true, result: 'ok' }; } });
      await ex.executeOne('tool-bash', { command: 'rm -r src/core' }, 's1', 'c1');
      await ex.executeOne('tool-bash', {
        command: 'rm -r src/core',
        danger_ack: { reason: LONG_REASON, files: 7, scope: 'inside' },
      }, 's1', 'c1');
      assert(captured, 'handler 应被调用');
      assertEquals(captured.danger_ack, undefined,
        `danger_ack 泄漏进工具参数：${JSON.stringify(captured)}`);
      assertEquals(captured.command, 'rm -r src/core', '原始参数必须原样保留');
      console.log('       [实测] 执行时 danger_ack 已被剥离，command 原样');
    });

    // ── T3 护栏必须真的接线 ────────────────────────────────────────────
    runner.test('R0-119/T3 捆仙索 local 必须接线：注册服务 ≠ 接管护栏（装了不生效是缺陷）', async () => {
      const src = read('plugins/kunxiansuo-local.js');
      assert(/setFence\s*\(/.test(src),
        'kunxiansuo-local 必须调用 setFence() 接管工具护栏：否则写进场景只是"存在但完全不跑"');
      assert(/removeFence\s*\(/.test(src),
        'stop() 必须 removeFence() 摘掉护栏：否则卸载插件后护栏仍指向已停止的实例');
      assert(/markRead\s*\(/.test(src),
        '必须接线 markRead：否则"读前必读"永远认为没读过，第一次写入就被自己拦死');

      const { ex, core } = await makeExecutor({ workDir: ws });
      const Kx = (await imp('plugins/kunxiansuo-local.js')).default;
      await Kx.init(core);
      assertEquals(ex._postHooks.some((h) => h.owner === 'kunxiansuo-local'), true,
        'markRead 必须通过 postHook 接线（tool-read 成功后登记）');

      // 接线后危险命令仍要拦（护栏真的在跑）
      const blocked = await ex._checkPreFlight('tool-bash', { command: 'cat /etc/passwd' }, 's1', 'c1');
      assert(blocked, '接线后硬拦必须生效');
      assertEquals(blocked.diagnostic.code, 'Y024', `硬拦判据码应为 Y024，实际 ${blocked.diagnostic.code}`);

      await Kx.stop();
      assertEquals(ex._postHooks.length, 0, 'stop() 必须摘掉自己的 postHook');
      console.log('       [实测] setFence/markRead 均已接线，护栏真的在跑，stop() 干净卸载');
    });

    // ── T4 护栏不得把正常写入挡死 ──────────────────────────────────────
    runner.test('R0-119/T4 护栏可用性：新建文件必须放行；改已存在文件才要求先读', async () => {
      const { ex, core } = await makeExecutor({ workDir: ws });
      const Kx = (await imp('plugins/kunxiansuo-local.js')).default;
      await Kx.init(core);

      // 新建文件：物理上不可能"先读一个不存在的文件"
      const create = await ex._checkPreFlight('tool-write', { path: 'brand-new.js' }, 's1', 'c1');
      assertEquals(create, null, '新建文件被"读前必读"挡住了——这条规则会把正常创建永久禁止');

      // 改已存在的文件：没读过 → 拦（这是规则的正当用途）
      const unread = await ex._checkPreFlight('tool-write', { path: 'README.md' }, 's1', 'c1');
      assert(unread, '改写未读过的已存在文件必须被拦');
      assertEquals(unread.diagnostic.code, 'WRITE_BEFORE_READ', `判据码应为 WRITE_BEFORE_READ，实际 ${unread.diagnostic.code}`);

      // 读过之后 → 放行（相对路径也必须能对上，否则规则永远无法满足）
      for (const h of ex._postHooks) h.fn('tool-read', { path: 'README.md' }, 'x', 's1', 'c1', 1);
      const after = await ex._checkPreFlight('tool-write', { path: 'README.md' }, 's1', 'c1');
      assertEquals(after, null,
        '读过同一文件后仍被拦：说明读记录用的是绝对路径、比对用的是相对路径（永远比不上）');
      await Kx.stop();
      console.log('       [实测] 新建放行、改写未读拦、读后放行（相对/绝对路径能对上）');
    });

    // ── T5 双闸不得互相打架 ────────────────────────────────────────────
    runner.test('R0-119/T5 双闸协调：软闸确认后，护栏的"见 rm 就拦"必须让路（否则确认了也没用）', async () => {
      const { ex, core } = await makeExecutor({ workDir: ws });
      const Kx = (await imp('plugins/kunxiansuo-local.js')).default;
      await Kx.init(core);

      // 护栏单独拦 `mv`（未经软闸的操作，护栏照常负责）
      const guardAlone = await ex._checkPreFlight('tool-bash', { command: 'mv a b' }, 's1', 'c1');
      assert(guardAlone, '未经软闸确认的 mv 仍应由护栏拦');
      assertEquals(guardAlone.diagnostic.code, 'CMD_GUARD', `护栏判据码应为 CMD_GUARD，实际 ${guardAlone.diagnostic.code}`);

      // 软闸给出挑战
      const challenge = await ex._checkPreFlight('tool-bash', { command: 'rm -r src/core' }, 's1', 'c1');
      assertEquals(challenge.diagnostic.code, 'Y025', '应先由软闸给出挑战');

      // 确认后必须能真正放行（此前会被 CMD_GUARD 二次拦死）
      const confirmed = await ex._checkPreFlight('tool-bash', {
        command: 'rm -r src/core',
        danger_ack: { reason: LONG_REASON, files: 7, scope: 'inside' },
      }, 's1', 'c1');
      assertEquals(confirmed, null,
        '软闸已确认，护栏仍以 CMD_GUARD 拦下 ⇒ "核对完影响面也没用"，比不做软闸更糟');
      await Kx.stop();
      console.log('       [实测] 护栏拦未确认的 mv；软闸确认后护栏让路，rm 可执行');
    });

    // ── T5b 硬拦优先于软闸（顺序不能反）───────────────────────────────
    runner.test('R0-119/T5b 顺序：硬拦（Y024）优先于软闸（Y025），破坏性命令不得被"确认"放行', async () => {
      const { ex, runs } = await makeExecutor({ workDir: ws });
      const r = await ex._checkPreFlight('tool-bash', { command: 'rm -rf /' }, 's1', 'c1');
      assert(r, 'rm -rf / 必须被拒绝');
      assertEquals(r.diagnostic.code, 'Y024',
        `rm -rf / 必须走硬拦 Y024（直接拒绝），实际 ${r.diagnostic.code} —— 若走 Y025，等于"填个理由就能删根目录"`);
      assertEquals(runs(), 0, '硬拦不得执行');
      // 即使带确认也不放行
      const r2 = await ex._checkPreFlight('tool-bash', {
        command: 'rm -rf /', danger_ack: { reason: LONG_REASON, files: 0, scope: 'inside' },
      }, 's1', 'c1');
      assert(r2 && r2.diagnostic.code === 'Y024', '硬拦的操作带确认也必须仍被拒绝');
      console.log('       [实测] rm -rf / 恒为 Y024，确认字段无法将其降级');
    });

    // ── T7 场景覆盖：能删能改的场景必须默认带护栏 ─────────────────────
    runner.test('R0-119/T7 场景覆盖：装配了危险工具的场景必须默认带捆仙索（LLM 能删的地方就有护栏）', async () => {
      const { loadJson5 } = await imp('src/core/json5-loader.js');
      const SCENES = join(ROOT, 'scenes');
      const list = readdirSync(SCENES).filter((f) => f.endsWith('.json5'));
      assert(list.length > 0, 'scenes/ 下应有场景');

      // "能删能改"的判据：这些插件名一旦出现，模型就能在磁盘上造成不可逆后果
      const DANGEROUS = /^tool-(bash|write|rm|mv|cp|executor)$/;
      const bad = [];
      const covered = [];

      for (const f of list) {
        const scene = loadJson5(readFileSync(join(SCENES, f), 'utf8'));
        const all = [...(scene.eager || []), ...(scene.plugins || []),
          ...(scene.optional || []), ...(scene.lazy || [])];
        const dangerous = all.filter((n) => DANGEROUS.test(n));
        const hasFence = all.includes('kunxiansuo-local');
        if (dangerous.length === 0) continue;          // 纯对话场景，不需要护栏
        if (!hasFence) bad.push(`${f}（危险工具：${dangerous.join(',')}）`);
        else covered.push(f);
      }

      assertEquals(bad.length, 0,
        `下列场景让模型能删能改，却没有装配 kunxiansuo-local 护栏：\n  ${bad.join('\n  ')}\n`
        + '护栏与危险工具必须同时在场——否则"安全取决于用户挑了哪个场景"这个老毛病会复发（R0-105 的教训）');
      assert(covered.length >= 3, `至少 gateway/coding/agent-platform 三个场景应带护栏，实际 ${covered.join(',')}`);
      console.log(`       [实测] ${covered.length} 个含危险工具的场景全部带护栏：${covered.join(', ')}`);
    });

    // ── T8 刻意不含的能力，不得以"随包存在"冒充 ─────────────────────────
    runner.test('R0-119/T8 刻意不含：照妖镜已移除、戒尺不随包（开发版频繁升级，锚点必过期）', async () => {
      const { existsSync } = await import('node:fs');

      // 照妖镜：依赖外部诊断服务只读库，开源版没有 → 整块移除，不留"永不启用的分支"
      assertEquals(existsSync(join(ROOT, 'plugins', 'kunxiansuo', 'zhaoyaojing.js')), false,
        'zhaoyaojing.js（照妖镜）应已移除：它只在外部诊断服务的库上工作，留着是永不启用的死分支');
      const local = read('plugins/kunxiansuo-local.js');
      assert(!/createZhaoyaojing|from '\.\/kunxiansuo\/zhaoyaojing/.test(local),
        'kunxiansuo-local 不得再 import 照妖镜');

      // 戒尺：校验捆仙索自身的锚点哈希；开发版每次升级都会改动这些文件 → 锚点必然过期
      assertEquals(existsSync(join(ROOT, 'plugins', 'kunxiansuo', 'jiechi.js')), false,
        'jiechi.js（戒尺）不应随开源包：它保护的是护栏自身的完整性，而本项目持续升级、持续改这些文件');

      // 文档必须如实说明"为什么不含"，而不是假装有
      const zh = read('README.md');
      assert(/戒尺/.test(zh) && /(刻意不含|不随包|不含)/.test(zh),
        'README 必须明确说明戒尺不随包，以及原因');
      assert(!/戒尺熔断/.test(zh),
        'README 不得再把戒尺写成"熔断"——戒尺做的是锚点防篡改，熔断是另一套机制');
      console.log('       [实测] 照妖镜已移除、戒尺不随包，README 如实说明原因');
    });

    // ── T6 文档必须与实况一致 ──────────────────────────────────────────
    runner.test('R0-119/T6 文档诚实性：README 必须说明默认场景有没有护栏，且不得声称"默认启用"', async () => {
      const zh = read('README.md');
      assert(/捆仙索/.test(zh), 'README 必须提到捆仙索');
      assert(/默认不装配|默认.{0,6}不(含|启用|装配)/.test(zh),
        'README 必须写明默认场景**不含**捆仙索（否则用户以为默认有安全底座）');
      assert(/Y025|不可恢复|影响面/.test(zh),
        'README 必须写明"不可恢复操作要核对影响面"这条新行为（否则模型/用户不知道会被问）');
      console.log('       [实测] README 如实标注默认场景与软闸行为');
    });

    // ── T9–T12：围栏四缺陷的回归锁（先复现、再修；锁行为不锁实现） ──────
    // 这四条共同点是「看起来在工作」：日志正常、状态接口正面、没有任何异常。
    // 所以锁必须是**行为级**的：走真实装配路径，断言判据真的被调用。

    /** 与 CLI 同一条装配（createRuntime → PluginManager.loadAll → core.start）。
     *  只有这条路能暴露「插件 import 插件」拿到的是另一个模块实例 —— 直接 new 执行器测不出来。 */
    const wireRuntime = async () => {
      const { createRuntime } = await imp('src/core/core.js');
      const { PluginManager } = await imp('src/core/plugin-manager.js');
      const stateDir = join(mkdtempSync(join(tmpdir(), 'tt-wire-')), 'state');
      const rt = createRuntime({ stateDir, pluginsDir: join(ROOT, 'plugins') });
      const pm = new PluginManager(rt.core);
      rt.core.registerService('plugin-manager', pm);
      pm.addDirectory(join(ROOT, 'plugins'));
      await pm.loadAll(['config', 'tool-executor', 'kunxiansuo-local']);
      await rt.core.start();
      return { rt, exec: rt.core.getService('tool-executor') };
    };

    runner.test('R0-119/T9 围栏表必须跨模块实例可见：真实装配下执行器真的调用捆仙索', async () => {
      const { rt, exec } = await wireRuntime();
      try {
        const mv = await exec._checkPreFlight('tool-bash', { command: 'mv /tmp/a /tmp/b' }, 's', null);
        assertEquals(mv?.diagnostic?.code, 'CMD_GUARD',
          '装载路径下执行器必须真的调用围栏（修前这里返回 null：围栏写进了另一个模块实例的 Map）');
        const env = await exec._checkPreFlight('tool-write', { path: '.env' }, 's', null);
        assertEquals(env?.diagnostic?.code, 'FS_GUARD', '敏感路径判据必须生效，不能只“状态报装了”');
        // 观测面与判据必须同源：状态说装了，就必须真的在拦。
        const { fenceStatus } = await imp('plugins/tool-executor.js');
        assert(fenceStatus(rt.core).installed === true, '状态接口必须报“已装配”');
        console.log('       [实测] 真实装配下 mv→CMD_GUARD、.env→FS_GUARD，状态与判据同源');
      } finally { await rt.core.stop(); }
    });

    runner.test('R0-119/T10 full-auto 只豁免“确认”，不得整块跳过围栏判据', async () => {
      const { rt, exec } = await wireRuntime();
      try {
        await rt.core.getService('config').setAndSave('tools.permissionMode', 'full-auto');
        const mv = await exec._checkPreFlight('tool-bash', { command: 'mv /tmp/a /tmp/b' }, 's', null);
        assert(!mv?.status, 'full-auto 是用户显式选择“不要打断”：不可恢复命令不得被 CMD_GUARD 二次拒绝');
        for (const p of ['.env', '.git/config']) {
          const r = await exec._checkPreFlight('tool-write', { path: p }, 's', null);
          assertEquals(r?.diagnostic?.code, 'FS_GUARD', `${p}：敏感路径判据不随 full-auto 关闭`);
        }
        console.log('       [实测] full-auto 下 mv 放行（豁免确认），.env/.git/config 仍 FS_GUARD');
      } finally { await rt.core.stop(); }
    });

    runner.test('R0-119/T11 服务名必须与注册名一致：manifest 不得写点号别名', async () => {
      const { rt } = await wireRuntime();
      try {
        assert(rt.core.getService('tool-executor'), '按注册名必须取得到执行器');
        assert(!rt.core.getService('tool.executor'), '点号别名不是服务名，必须取不到');
        const { validateAssembly } = await imp('plugins/admission-gate.js');
        const fake = (name, requires) => ({ name, version: '1.0.0', owner: 't', provides: [], requires });
        const all = new Map(rt.core.plugins);
        all.set('probe-real', fake('probe-real', { 'tool-executor': '>=0.8.0' }));
        all.set('probe-dot', fake('probe-dot', { 'tool.executor': '>=0.8.0' }));
        const v = validateAssembly(all).violations || [];
        assert(!v.some((x) => x.plugin === 'probe-real'),
          '按真实注册名声明依赖不得被判缺失（修前这里红：准入表用的是 manifest 里的点号名）');
        assert(v.some((x) => x.plugin === 'probe-dot'),
          '按点号声明依赖必须被判缺失（修前这里绿：运行时 getService 是 null，等于假绿灯）');
        console.log('       [实测] 真名通过、点号被点名；manifest 与 registerService 同名');
      } finally { await rt.core.stop(); }
    });

    runner.test('R0-119/T12 fenceStatus 的 count/all 必须按 core 过滤', async () => {
      const { setFence, removeFence, fenceStatus } = await imp('plugins/tool-executor.js');
      const cA = { tag: 'A' }, cB = { tag: 'B' };
      const a = setFence({ preCheck() {} }, { owner: 'fence-A', core: cA });
      const b = setFence({ preCheck() {} }, { owner: 'fence-B', core: cB });
      try {
        const sa = fenceStatus(cA), sb = fenceStatus(cB), global = fenceStatus(null);
        assertEquals(sa.owner, 'fence-A');
        assertEquals(sb.owner, 'fence-B');
        assertEquals(sa.all.filter((x) => x.owner === 'fence-B').length, 0, 'A 的 all[] 不得含 B 的围栏');
        assertEquals(sb.all.filter((x) => x.owner === 'fence-A').length, 0, 'B 的 all[] 不得含 A 的围栏');
        assertEquals(sa.count, sa.all.length, 'count 必须与 all 同源');
        assert(sa.count < global.count, '单个 core 的读数必须窄于进程级总数');
        console.log('       [实测] 两个 core 各报 1 条，all[] 不含对方，count 与 all 同源');
      } finally { removeFence(a); removeFence(b); }
    });
  }
}
