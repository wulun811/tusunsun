// rc.23：专家 R22-A..F 六项整改，每条都是**先复现后修 + 对称正控**。
//
// 与 rc.22 那份的区别：那批是"判据在、但在某些分支上不生效"；这批是"回执与真实状态脱钩"——
// 工具说成功了，磁盘上的东西却是另一回事。所以每条两个方向都要成立：
//   · 反例：修前的真实形态 → 必须被具名拒绝 / 状态必须闭合；
//   · 正控：合法用法 → 必须照常成功（判据不能靠"一律拒绝"变绿）。
//
//   A  tool-cp 默认静默覆盖目标、目录合并、写穿符号链接、并发同目标（P1，丢用户数据）
//   B  tool-rm 按条数无条件永久删除，回执指向的文件被自动清掉（P1）
//   C  secrets.set/delete 落盘失败只 warn，缓存与磁盘不一致（P1）
//   D  tool-rm 跨设备删目录：cp 之后固定 unlink ⇒ 原件与副本同时存在（P2）
//   E  tar 成员读取依赖外部 tar 的展示层转义 ⇒ Unicode 名判据假红（P2）
//   F  压测汇总看不见"套件崩了" ⇒ 退出码 1 与"硬门禁失败 0"同时出现（P2）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `rc23-${tag}-`));
}

/** 最小 core 桩：只提供被测工具真正用到的那几面。 */
function stubCore({ workDir, stateDir, config = null, caps = null }) {
  return {
    stateDir,
    getData: () => workDir,
    getService: (n) => (n === 'config' ? config : null),
    registerCapability: (name, handler) => { if (caps) caps[name] = handler; },
    log() {},
  };
}

export async function setup(runner) {
  // ── A：tool-cp 默认拒绝覆盖 ────────────────────────────────────────
  runner.test('rc.23/A tool-cp 默认不得覆盖已有目标；显式 overwrite 才允许且回执点名被替换内容', async () => {
    const base = tempDir('a');
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    const cp = (await imp('plugins/tools/tool-cp.js')).default;
    cp.core = stubCore({ workDir: ws, stateDir: base });

    writeFileSync(join(ws, 'src.txt'), 'NEW-FILE');
    writeFileSync(join(ws, 'dest.txt'), 'OLD-IMPORTANT');

    // 反例：修前这里返回 {ok:true, bytes:8}，dest.txt 内容被不可恢复地替换。
    let err = null;
    try { await cp.execute({ src: 'src.txt', dest: 'dest.txt' }); } catch (e) { err = e; }
    assert(err, '未显式 overwrite 时覆盖已有目标必须失败，不得静默替换');
    assertEquals(err.code, 'dest_exists', '必须是具名的 dest_exists，而不是笼统的 resource_error');
    assertEquals(readFileSync(join(ws, 'dest.txt'), 'utf8'), 'OLD-IMPORTANT', '被拒时旧文件必须一字不动');

    // 正控①：显式 overwrite 必须照常成功，并在回执里给出**旧内容的指纹**。
    const ok = await cp.execute({ src: 'src.txt', dest: 'dest.txt', overwrite: true });
    assert(ok.ok, '显式 overwrite:true 必须允许覆盖');
    assertEquals(readFileSync(join(ws, 'dest.txt'), 'utf8'), 'NEW-FILE', '覆盖后内容必须是新文件');
    assert(ok.replaced && ok.replaced.sha256, '回执必须点名被替换的旧内容指纹（否则"覆盖了什么"无法回放）');
    assert(readdirSync(ws).every((n) => !n.includes('.cprev-') && !n.includes('.cptmp-')),
      '覆盖成功后不得留下备份/暂存残渣');

    // 正控②：目标不存在时照常创建（判据不能靠"一律拒绝"变绿）。
    const fresh = await cp.execute({ src: 'src.txt', dest: 'brand-new.txt' });
    assert(fresh.ok, '目标不存在时必须照常拷贝');
    assertEquals(readFileSync(join(ws, 'brand-new.txt'), 'utf8'), 'NEW-FILE', '新文件内容必须正确');

    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/A2 tool-cp 不得合并进已有目录、不得写穿目标符号链接', async () => {
    const base = tempDir('a2');
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    const cp = (await imp('plugins/tools/tool-cp.js')).default;
    cp.core = stubCore({ workDir: ws, stateDir: base });

    // 反例①：往已有目录里 merge —— 目标里原本有什么取决于是否同名，回执只有一个 bytes。
    mkdirSync(join(ws, 'sd')); writeFileSync(join(ws, 'sd/x.txt'), 'X');
    mkdirSync(join(ws, 'dd')); writeFileSync(join(ws, 'dd/y.txt'), 'Y');
    let err = null;
    try { await cp.execute({ src: 'sd', dest: 'dd' }); } catch (e) { err = e; }
    assert(err, '默认不得合并进已有目录');
    assertEquals(err.code, 'dest_exists', '目录合并被拒必须具名');
    assertEquals(readdirSync(join(ws, 'dd')).join(','), 'y.txt', '被拒时目标目录必须一字不动');

    // 反例②：目标是指向工作区内的符号链接 —— 写穿链接改的是链接指向的文件，不是 dest。
    writeFileSync(join(ws, 'covered.txt'), 'COVERED-ORIGINAL');
    symlinkSync(join(ws, 'covered.txt'), join(ws, 'lnk'));
    writeFileSync(join(ws, 'via.txt'), 'VIA-LINK');
    err = null;
    try { await cp.execute({ src: 'via.txt', dest: 'lnk' }); } catch (e) { err = e; }
    assert(err, '目标是符号链接时必须按"已存在"拒绝');
    assertEquals(readFileSync(join(ws, 'covered.txt'), 'utf8'), 'COVERED-ORIGINAL',
      '不得写穿符号链接（链接指向的文件必须原样）');

    // 正控：目录拷到**不存在**的目标必须照常成功。
    mkdirSync(join(ws, 'sd2')); writeFileSync(join(ws, 'sd2/z.txt'), 'Z');
    const ok = await cp.execute({ src: 'sd2', dest: 'dd2' });
    assert(ok.ok, '目标不存在时目录拷贝必须成功');
    assertEquals(readFileSync(join(ws, 'dd2/z.txt'), 'utf8'), 'Z', '目录内容必须完整');

    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/A3 tool-cp 跨进程并发写同一目标：只能有一个成功（内核判据，不是先查后写）', async () => {
    // **为什么必须是多进程**：单进程里 `existsSync` 与 `rename` 之间没有 await，
    // 事件循环插不进另一个任务 —— 「先查后写」这种形态**在进程内根本观察不到**。
    // 真实竞争来自多个 agent 进程同时写同一路径。
    //
    // **怎么才测得出来**：窗口在微秒量级，而 `execute()` 内部还要读源、写暂存。
    // 若闸门放在 execute 之前，放行后每个进程仍要各走一遍那些步骤，抖动把窗口错开
    // （实测：24 进程 × 10 回合、无闸门 0/10；闸门放 execute 之前约 4/8）。
    // 所以闸门必须卡在**落位那一刻**。这里用 `_linkOrCopy` 的注入点实现：
    // 被测的正是这一段，桩只负责在进入它之前对齐所有进程。
    const base = tempDir('a3x');
    const ws = join(base, 'ws');
    mkdirSync(join(ws, 'out'), { recursive: true });
    const N = 24;
    const ROUNDS = 4;
    for (let i = 0; i < N; i++) writeFileSync(join(ws, `c${i}.txt`), `C${i}`);

    const worker = join(base, 'worker.mjs');
    writeFileSync(worker, `
      const { existsSync, writeFileSync } = await import('node:fs');
      const { default: cp } = await import(${JSON.stringify(join(ROOT, 'plugins/tools/tool-cp.js'))});
      cp.core = { getData: () => ${JSON.stringify(ws)}, getService: () => null };
      const i = process.argv[2];
      const dest = process.argv[3];
      const gate = process.argv[4];
      // 就绪握手（写 .ready 文件）而不是固定 sleep：固定等待在慢机器上会漏放行，
      // 让"该红的没红"变成一条随机通过的用例 —— 那比没有用例更糟。
      // 闸门卡在 _linkOrCopy 入口：那是落位判据真正执行的位置。
      const real = cp._linkOrCopy.bind(cp);
      cp._linkOrCopy = async (tmp, fullDest) => {
        writeFileSync(gate + '.ready.' + process.pid, '1');
        while (!existsSync(gate)) { /* spin */ }
        return real(tmp, fullDest);
      };
      try { await cp.execute({ src: 'c' + i + '.txt', dest }); console.log('OK'); }
      catch (e) { console.log('ERR:' + (e.code || e.message)); }
    `);
    const { spawn } = await import('node:child_process');
    const { readdirSync: rd } = await import('node:fs');

    let roundSeq = 0;
    const runRound = async (destFor) => {
      const tag = `gate${roundSeq++}`;
      const gate = join(base, tag);
      const procs = Array.from({ length: N }, (_, i) => new Promise((res) => {
        const ch = spawn(process.execPath, [worker, String(i), destFor, gate], { stdio: ['ignore', 'pipe', 'pipe'] });
        let o = ''; ch.stdout.on('data', (d) => o += d); ch.stderr.on('data', (d) => o += d);
        ch.on('close', () => res(o.trim()));
      }));
      // 等到**全部** worker 都真正卡在落位前再放行。
      for (let t = 0; t < 3000; t++) {
        if (rd(base).filter((f) => f.startsWith(`${tag}.ready.`)).length >= N) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(rd(base).filter((f) => f.startsWith(`${tag}.ready.`)).length, N,
        '所有 worker 必须都到达落位前（否则这条用例测的不是并发）');
      writeFileSync(gate, 'go');
      return Promise.all(procs);
    };

    let totalOk = 0;
    const detail = [];
    for (let round = 0; round < ROUNDS; round++) {
      for (const f of readdirSync(join(ws, 'out'))) rmSync(join(ws, 'out', f), { force: true });
      for (let i = 0; i < N; i++) writeFileSync(join(ws, `c${i}.txt`), `C${i}`);
      const outs = await runRound('out/target.txt');
      const ok = outs.filter((o) => o === 'OK').length;
      totalOk += ok;
      detail.push(ok);
    }
    assertEquals(totalOk, ROUNDS,
      `每回合只能有一个成功（实测各回合成功数 ${JSON.stringify(detail)} = 静默覆盖，写进去的只是最后一个的内容）`);
    assert(readdirSync(join(ws, 'out')).every((n) => n === 'target.txt'), '不得留下暂存残渣');

    // 正控：同一批 24 个进程、同一个闸门，但各自写**不同**目标 —— 必须 24 个全成功。
    // 这一条把"并发本身"与"同一目标"分开：前者不该被拒，后者才必须只有一个赢。
    for (const f of readdirSync(join(ws, 'out'))) rmSync(join(ws, 'out', f), { force: true });
    for (let i = 0; i < N; i++) writeFileSync(join(ws, `c${i}.txt`), `C${i}`);
    const tagU = `gateU${roundSeq++}`;
    const gateU = join(base, tagU);
    const procsU = Array.from({ length: N }, (_, i) => new Promise((res) => {
      const ch = spawn(process.execPath, [worker, String(i), `out/u${i}.txt`, gateU], { stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; ch.stdout.on('data', (d) => o += d); ch.stderr.on('data', (d) => o += d);
      ch.on('close', () => res(o.trim()));
    }));
    for (let t = 0; t < 3000; t++) {
      if (rd(base).filter((f) => f.startsWith(`${tagU}.ready.`)).length >= N) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    writeFileSync(gateU, 'go');
    const outsU = await Promise.all(procsU);
    assertEquals(outsU.filter((o) => o === 'OK').length, N, '不同目标的并发拷贝必须全部成功');

    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/A4 tool-mv 跨进程并发移动同一目标：只能有一个成功（与 tool-cp 同一判据）', async () => {
    // rc.22 修了 tool-mv 的"默认拒绝覆盖"，但用的是 `existsSync` 再 `rename` ——
    // 那是两段，中间有窗口。实测（24 进程 × 4 回合，闸门同步到落位）有 1 个回合
    // 出现 2 个进程同时成功：两次都报 ok，后一个静默覆盖前一个的**目标**，
    // 而前一个的源文件已经被删掉了 —— 两份内容只剩一份。
    // 专家报告把这条列为"12 次 5 并发未复现、不列为已复现缺陷"；本轮用闸门复现到了。
    const base = tempDir('a4x');
    const ws = join(base, 'ws');
    mkdirSync(join(ws, 'out'), { recursive: true });
    const N = 24;
    for (let i = 0; i < N; i++) writeFileSync(join(ws, `c${i}.txt`), `C${i}`);
    const worker = join(base, 'worker.mjs');
    writeFileSync(worker, `
      const { existsSync, writeFileSync } = await import('node:fs');
      const { default: mv } = await import(${JSON.stringify(join(ROOT, 'plugins/tools/tool-mv.js'))});
      mv.core = { getData: () => ${JSON.stringify(ws)}, getService: () => null };
      const i = process.argv[2], dest = process.argv[3], gate = process.argv[4];
      writeFileSync(gate + '.ready.' + process.pid, '1');
      while (!existsSync(gate)) { /* spin */ }
      try { await mv.execute({ src: 'c' + i + '.txt', dest }); console.log('OK'); }
      catch (e) { console.log('ERR:' + (e.code || e.message)); }
    `);
    const { spawn } = await import('node:child_process');
    const { readdirSync: rd } = await import('node:fs');
    let totalOk = 0;
    const detail = [];
    for (let round = 0; round < 4; round++) {
      for (const f of readdirSync(join(ws, 'out'))) rmSync(join(ws, 'out', f), { force: true });
      for (let i = 0; i < N; i++) writeFileSync(join(ws, `c${i}.txt`), `C${i}`);
      const tag = `mvg${round}`;
      const gate = join(base, tag);
      const procs = Array.from({ length: N }, (_, i) => new Promise((res) => {
        const ch = spawn(process.execPath, [worker, String(i), 'out/target.txt', gate], { stdio: ['ignore', 'pipe', 'pipe'] });
        let o = ''; ch.stdout.on('data', (d) => o += d); ch.stderr.on('data', (d) => o += d);
        ch.on('close', () => res(o.trim()));
      }));
      for (let t = 0; t < 3000; t++) {
        if (rd(base).filter((f) => f.startsWith(`${tag}.ready.`)).length >= N) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assertEquals(rd(base).filter((f) => f.startsWith(`${tag}.ready.`)).length, N,
        '所有 worker 必须都到达落位前');
      writeFileSync(gate, 'go');
      const outs = await Promise.all(procs);
      const ok = outs.filter((o) => o === 'OK').length;
      totalOk += ok;
      detail.push(ok);
    }
    assertEquals(totalOk, 4,
      `每回合只能有一个成功（实测 ${JSON.stringify(detail)}）—— 多于一个就说明有源文件被删而内容被覆盖`);

    // 正控①：目标不存在时普通移动必须成功且源消失。
    writeFileSync(join(ws, 'solo.txt'), 'SOLO');
    const mv = (await imp('plugins/tools/tool-mv.js')).default;
    mv.core = stubCore({ workDir: ws, stateDir: base });
    const r = await mv.execute({ src: 'solo.txt', dest: 'out/solo-moved.txt' });
    assert(r.ok, '普通移动必须成功');
    assert(!existsSync(join(ws, 'solo.txt')), '移动后源必须消失');
    assertEquals(readFileSync(join(ws, 'out/solo-moved.txt'), 'utf8'), 'SOLO', '内容必须完整');
    // 正控②：目录移动仍须可用（link 不支持目录，走 rename）。
    mkdirSync(join(ws, 'adir')); writeFileSync(join(ws, 'adir/x.txt'), 'X');
    const rd2 = await mv.execute({ src: 'adir', dest: 'out/adir2' });
    assert(rd2.ok, '目录移动必须成功');
    assertEquals(readFileSync(join(ws, 'out/adir2/x.txt'), 'utf8'), 'X', '目录内容必须完整');

    rmSync(base, { recursive: true, force: true });
  });

  // ── B：回收站不得按条数无授权永久删除 ──────────────────────────────
  runner.test('rc.23/B 回执里给出的 trashed 路径不得被自动永久删除；清理必须显式且可审计', async () => {
    const base = tempDir('b');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(ws, { recursive: true });
    const tool = (await imp('plugins/tools/tool-rm.js')).default;
    await tool.init(stubCore({ workDir: ws, stateDir }));

    writeFileSync(join(ws, 'important.txt'), 'IRREPLACEABLE');
    const first = await tool.execute({ path: 'important.txt' });
    assert(first.ok, '正常删除必须成功');
    assert(first.retention, '回执必须带上保留策略 —— 否则"可恢复"是无期限承诺');
    assertEquals(first.retention.autoPrune, false, '默认不得自动清理（不可逆操作需要上层授权）');
    assert(typeof first.retention.statement === 'string' && first.retention.statement.includes('trash.prune'),
      '回执必须说清"什么时候会被清掉"，而不是只说可恢复');

    // 反例形状：把回收站推过 500 条（rc.22 的 _pruneTrash 在这里会永久删掉最旧的）。
    for (let i = 0; i < 505; i++) {
      writeFileSync(join(ws, `f${i}.txt`), `c${i}`);
      await tool.execute({ path: `f${i}.txt` });
    }
    assertEquals(readdirSync(join(stateDir, 'trash')).length, 506,
      '超过水位线也不得自动删除任何条目');
    assert(existsSync(first.trashed), '回执指向的文件必须还在（修前在此处已被永久删除）');
    assertEquals(readFileSync(first.trashed, 'utf8'), 'IRREPLACEABLE', '内容必须一字不少');

    // 正控①：显式 prune 只删**过保留期**的，且 dry-run 不动任何文件。
    const names = readdirSync(join(stateDir, 'trash'));
    const victim = join(stateDir, 'trash', names[0]);
    const old = new Date(Date.now() - 60 * 86400_000);
    (await import('node:fs')).utimesSync(victim, old, old);
    const dry = await tool.prune({ dryRun: true });
    assertEquals(dry.deleted.length, 1, 'dry-run 应报告 1 条过期条目');
    assert(existsSync(victim), 'dry-run 绝不得真删');
    const real = await tool.prune({ maxAgeDays: 30 });
    assertEquals(real.deleted.length, 1, '显式 prune 应删掉那 1 条过期条目');
    assert(!existsSync(victim), '过期条目必须被真删');
    assert(existsSync(join(stateDir, 'trash-prune.log')), '不可逆操作必须留下审计记录');
    const audit = readFileSync(join(stateDir, 'trash-prune.log'), 'utf8');
    assert(audit.includes('"action":"prune"') && audit.includes(names[0]),
      '审计记录必须点名删了哪一条');

    // 正控②：未过期的条目 prune 不得碰（不能在"清理"名义下清空回收站）。
    assert(existsSync(first.trashed), '30 天内最新的条目不得被 prune 删掉');

    rmSync(base, { recursive: true, force: true });
  });

  // ── A2：config 落盘失败必须把内存也撤回去（R23-A） ─────────────
  runner.test('rc.23/A2 config 落盘失败必须把内存里的新值撤回去（跨层一致）', async () => {
    const { default: configPlugin } = await imp('plugins/config.js');
    const base = tempDir('a2');
    const stateDir = join(base, 'state');
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(stateDir, 'config.json');
    const core = {
      stateDir, configPath, log() {}, emit() {}, registerCapability() {}, registerService() {},
      setData() {}, getData() { return null; }, get() { return undefined; },
      getService() { return null; },
    };
    await configPlugin.init(core);
    try {
      const before = configPlugin.get('model.apiKey');
      // 让**落盘**失败，而不是"写入前就抛"：把目标路径做成一个目录 ⇒ rename 抛 EISDIR。
      // 修前 rc.23 的假配置服务在 set 之前就抛错，因此这条路径从没被跑到。
      rmSync(configPath, { force: true });
      mkdirSync(configPath);
      let err = null;
      try { await configPlugin.setAndSave('model.apiKey', 'NEW-VALUE'); } catch (e) { err = e; }
      assert(err, '落盘失败必须抛错');
      assertEquals(configPlugin.get('model.apiKey'), before,
        '内存必须回到旧值 —— 否则"失败"只存在于返回值里');
      assert(!JSON.stringify(configPlugin.data).includes('NEW-VALUE'), '内存里不得残留没落盘的新值');

      // 同一缺陷的上层表现：SecretsManager 回了自己的缓存，而**新的读取方**从 config 里
      // 解出了那个根本没落盘的新密钥 —— 一个失败，两层两个答案。
      rmSync(configPath, { recursive: true, force: true });
      writeFileSync(configPath, '{}');
      process.env.TUSUNSUN_SECRET_KEY = 'rc23-a2-master';
      const { SecretsManager } = await imp('plugins/_lib/secrets.js');
      const sc = { stateDir, log() {}, getService: (n) => (n === 'config' ? configPlugin : null) };
      const s = new SecretsManager(sc);
      await s.set('model.apiKey', 'OLD-SECRET');
      assertEquals(s.get('model.apiKey'), 'OLD-SECRET', '正控：先存一条旧密钥');
      rmSync(configPath, { force: true });
      mkdirSync(configPath);
      let err2 = null;
      try { await s.set('model.apiKey', 'NEW-SECRET'); } catch (e) { err2 = e; }
      assertEquals(err2?.code, 'secrets_persist_failed', '落盘失败必须是具名的 secrets_persist_failed');
      assertEquals(new SecretsManager(sc).get('model.apiKey'), 'OLD-SECRET',
        '缓存为空的读取方只能从 config 解密：修前这里读到 NEW-SECRET（没落盘却已生效）');
      delete process.env.TUSUNSUN_SECRET_KEY;

      // A2c：落盘期间发生外部 reload（`this.data` 被换成另一个对象）⇒ 回滚必须**跳过**。
      // 不做这个守卫时，回滚会把旧快照整段写回新对象，等于把刚重载的配置抹掉 ——
      // 而 watcher 正是被 `save()` 自己触发的，这个窗口在真实运行里天天开着。
      const saved = configPlugin.save.bind(configPlugin);
      configPlugin.save = async () => { configPlugin.data = { reloaded: true }; throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
      let err3 = null;
      try { await configPlugin.setAndSave('model.apiKey', 'AFTER-RELOAD'); } catch (e) { err3 = e; }
      configPlugin.save = saved;
      assert(err3, '落盘失败仍必须抛错');
      assertEquals(configPlugin.data.reloaded, true, 'reload 之后的对象不得被旧快照覆盖');
      assertEquals(configPlugin.data.model, undefined, '旧快照里的 model 不得被写回');
    } finally {
      await configPlugin.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });

  // ── C：secrets 落盘失败必须对调用方失败 ────────────────────────────
  runner.test('rc.23/C secrets 落盘失败必须具名抛错并回滚缓存；成功路径必须跨重启可读', async () => {
    const { SecretsManager } = await imp('plugins/_lib/secrets.js');
    const stateDir = tempDir('c');
    process.env.TUSUNSUN_SECRET_KEY = 'rc23-stable-master';

    // 反例①：注入 EACCES。修前 `await set(...)` 正常完成，本进程读得到、磁盘上没有。
    {
      const store = new Map();
      const core = { stateDir, log() {}, getService: () => ({
        get: (k) => store.get(k),
        setAndSave: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      }) };
      const s = new SecretsManager(core);
      let err = null;
      try { await s.set('model.apiKey', 'SENSITIVE'); } catch (e) { err = e; }
      assert(err, '落盘失败时 set 必须抛错（修前只是 warn 后 resolve）');
      assertEquals(err.code, 'secrets_persist_failed', '必须是具名的 secrets_persist_failed');
      assertEquals(s.get('model.apiKey'), null, '落盘失败时缓存必须回滚 —— 否则"本进程有、重启没有"');
      assertEquals(store.has('model.apiKey'), false, '磁盘上不得有值');
    }

    // 反例②：无稳定主密钥（默认部署）不得把"必然解不开的密文"当成功持久化。
    {
      const saved = process.env.TUSUNSUN_SECRET_KEY;
      delete process.env.TUSUNSUN_SECRET_KEY;
      delete process.env.TONGTIAN_SECRET_KEY;
      delete process.env.TUSUNSUN_SECRET_KEY_FILE;
      const disk = new Map();
      const mk = () => ({ stateDir, log() {}, getService: () => ({
        get: (k) => disk.get(k),
        setAndSave: async (k, v) => { if (v === undefined) disk.delete(k); else disk.set(k, v); },
      }) });
      const s = new SecretsManager(mk());
      assert(s._ephemeralKey, '无 SECRET_KEY 时应识别为 ephemeral');
      let err = null;
      try { await s.set('model.apiKey', 'sk-real'); } catch (e) { err = e; }
      assert(err, 'ephemeral 模式下不得把密钥存成"重启读不回"的样子');
      assertEquals(err.code, 'secrets_ephemeral_key', '必须具名说明缺稳定主密钥');
      assertEquals(disk.has('model.apiKey'), false, '磁盘上不得留下必然解不开的密文');
      process.env.TUSUNSUN_SECRET_KEY = saved;
    }

    // 正控①：有稳定密钥时，set → 重新初始化 → 必须读回明文。
    {
      const disk = new Map();
      const mk = () => ({ stateDir, log() {}, getService: () => ({
        get: (k) => disk.get(k),
        setAndSave: async (k, v) => { if (v === undefined) disk.delete(k); else disk.set(k, v); },
      }) });
      const s1 = new SecretsManager(mk());
      const r = await s1.set('model.apiKey', 'sk-real-key');
      assertEquals(r.persisted, true, '落盘成功时回执必须显式说 persisted:true');
      assertEquals(new SecretsManager(mk()).get('model.apiKey'), 'sk-real-key',
        '设置保存后必须能在重启后读到');

      // 正控②：delete 必须真的删掉（重启后不得复活）。
      await s1.delete('model.apiKey');
      assertEquals(new SecretsManager(mk()).get('model.apiKey'), null, '删除后重启不得复活');

      // 正控③：换错主密钥 ⇒ 返回 null 而不是密文（rc.22/B 的判据在这里不得回退）。
      await s1.set('model.apiKey', 'sk-again');
      process.env.TUSUNSUN_SECRET_KEY = 'rc23-wrong-master';
      assertEquals(new SecretsManager(mk()).get('model.apiKey'), null, '错主密钥必须返回 null');
      process.env.TUSUNSUN_SECRET_KEY = 'rc23-stable-master';
    }

    // 反例③：没有 config 服务 = 没有任何持久化能力，不得静默成功。
    {
      const s = new SecretsManager({ stateDir, log() {}, getService: () => null });
      process.env.TUSUNSUN_SECRET_KEY = 'rc23-stable-master';
      let err = null;
      try { await s.set('a', 'b'); } catch (e) { err = e; }
      assert(err, '无 config 服务时 set 不得假装成功');
      assertEquals(err.code, 'secrets_unavailable', '必须具名说明无处持久化');
    }

    delete process.env.TUSUNSUN_SECRET_KEY;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── B2：审计通道不可用时不得开始删除（R23-B） ───────────────────
  runner.test('rc.23/B2 先记账后删：审计写不进去就一条都不删，删完才发现写不进去要停下并对账', async () => {
    const tool = (await imp('plugins/tools/tool-rm.js')).default;
    const { utimesSync } = await import('node:fs');
    const base = tempDir('b2');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(ws, { recursive: true });
    await tool.init(stubCore({ workDir: ws, stateDir }));
    const old = new Date(Date.now() - 62 * 86400_000);
    const victim = join(stateDir, 'trash', 'old_entry');
    writeFileSync(victim, 'OLD');
    utimesSync(victim, old, old);

    // 审计盘写不进去：把日志路径做成一个**目录** ⇒ appendFile 抛 EISDIR。
    rmSync(join(stateDir, 'trash-prune.log'), { force: true });
    mkdirSync(join(stateDir, 'trash-prune.log'));
    let err = null;
    try { await tool.prune({ maxAgeDays: 30 }); } catch (e) { err = e; }
    assert(err, '审计写不进去必须抛错');
    assert(existsSync(victim), '修前：文件已被物理删除、账本却空白。修后：审计不可用时一条都不删');
    assertEquals(readFileSync(victim, 'utf8'), 'OLD', '内容必须一字不少');

    // 正控：审计可用时正常清理，且账是"intent + committed"两段可对账的。
    rmSync(join(stateDir, 'trash-prune.log'), { recursive: true, force: true });
    const r = await tool.prune({ maxAgeDays: 30 });
    assertEquals(r.deleted.length, 1);
    assert(!existsSync(victim));
    const log = readFileSync(join(stateDir, 'trash-prune.log'), 'utf8');
    assert(log.includes('"phase":"intent"') && log.includes('"phase":"committed"'),
      'intent 与 committed 都必须落盘 —— 只有结果没有意图，崩溃窗口就无从对账');
    assertEquals((await tool.reconcileIntents()).unresolved.length, 0, '正常路径不得留下未结算的意图');

    // 反例②：删除**之后**审计才坏。必须停手、具名，并把"删了但没记上"的条目报出来。
    for (const n of ['e1', 'e2', 'e3']) {
      writeFileSync(join(stateDir, 'trash', n), n);
      utimesSync(join(stateDir, 'trash', n), old, old);
    }
    const realAudit = tool._audit.bind(tool);
    let calls = 0;
    tool._audit = async (rows) => {
      calls++;
      if (calls > 2) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realAudit(rows);
    };
    let err2 = null;
    try { await tool.prune({ maxAgeDays: 30 }); } catch (e) { err2 = e; }
    tool._audit = realAudit;
    assert(err2, '审计在删除后坏掉必须抛错，不得静默继续删完');
    assertEquals(err2.code, 'prune_audit_failed', '必须是具名 prune_audit_failed');
    assertEquals(err2.unrecorded.length, 1, '必须点名"已删但没记上"的那一条');
    const rec = await tool.reconcileIntents();
    assert(rec.unresolved.length >= 1, '未结算的意图必须能被对账面看见');
    assertEquals(rec.unresolved[0].present, false, '磁盘上那条已不在 —— 对账面必须如实反映');

    rmSync(base, { recursive: true, force: true });
  });

  // ── D：跨设备删目录必须按类型收尾 ──────────────────────────────────
  runner.test('rc.23/D 跨设备删除目录不得让原件与回收站副本同时存在', async () => {
    const tool = (await imp('plugins/tools/tool-rm.js')).default;

    // 反例形状：工作区在 tmpfs/overlayfs，状态目录在另一个设备 ⇒ rename 抛 EXDEV。
    // 修前：cp(recursive) 之后固定 unlink ⇒ 源是目录时抛 EISDIR，
    // 工具报 resource_error，而**原件与回收站副本同时存在**。
    // 这里直接针对 _moveAcrossDevices 做判定，不依赖宿主是否真有两个设备。
    const base = tempDir('d');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(join(ws, 'proj'), { recursive: true });
    writeFileSync(join(ws, 'proj/a.txt'), 'A');
    await tool.init(stubCore({ workDir: ws, stateDir }));
    const trashPath = join(stateDir, 'trash', 'proj_cross_test');

    await tool._moveAcrossDevices(join(ws, 'proj'), trashPath);
    assert(!existsSync(join(ws, 'proj')), '跨设备移动成功后原件必须消失（修前目录留了下来）');
    assertEquals(readFileSync(join(trashPath, 'a.txt'), 'utf8'), 'A', '回收站副本必须完整');

    // 正控：单文件跨设备同样要收尾干净。
    writeFileSync(join(ws, 'single.txt'), 'S');
    const tp2 = join(stateDir, 'trash', 'single_cross_test');
    await tool._moveAcrossDevices(join(ws, 'single.txt'), tp2);
    assert(!existsSync(join(ws, 'single.txt')), '单文件跨设备移动后原件必须消失');
    assertEquals(readFileSync(tp2, 'utf8'), 'S', '单文件副本必须完整');

    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/D2 跨设备收尾失败必须保留完整副本、点名两份路径（注入确定性故障）', async () => {
    const tool = (await imp('plugins/tools/tool-rm.js')).default;
    const base = tempDir('d2');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(join(ws, 'keep'), { recursive: true });
    writeFileSync(join(ws, 'keep/a.txt'), 'A');
    await tool.init(stubCore({ workDir: ws, stateDir }));
    const trashPath = join(stateDir, 'trash', 'keep_rollback_test');

    // 确定性前提：注入"删原件必然失败"。用 chmod 造前提在 root 下不成立（T23-D2），
    // 而那正是"为了一条用例变绿而把 SKIP 记成 PASS"的起点。
    let err = null;
    try {
      await tool._moveAcrossDevices(join(ws, 'keep'), trashPath, {
        removeOriginal: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
      });
    } catch (e) { err = e; }

    assert(err, '原件删不掉时必须抛错，不得报成功');
    assertEquals(err.code, 'resource_error', '收尾失败必须是具名的 resource_error');
    assertEquals(err.rolled_back, false, 'rm 可能已部分成功：副本不得被撤回（撤掉唯一完整副本才是真丢数据）');
    assertEquals(err.partial_removal, true, '必须显式说明这是"可能部分删除"的不确定状态');
    assertEquals(err.trash_copy, trashPath, '回执必须点名那份完整副本在哪');
    assertEquals(err.original_exists, true, '回执必须说清原件是否还在');
    assertEquals(readFileSync(join(trashPath, 'a.txt'), 'utf8'), 'A', '副本必须是完整的（不能是半份）');
    assert(existsSync(join(ws, 'keep/a.txt')), '失败后原件必须原样还在');

    // 正控：正常路径必须成功且只留一份。
    mkdirSync(join(ws, 'keep2'), { recursive: true });
    writeFileSync(join(ws, 'keep2/b.txt'), 'B');
    const tp2 = join(stateDir, 'trash', 'keep2_ok');
    await tool._moveAcrossDevices(join(ws, 'keep2'), tp2);
    assert(!existsSync(join(ws, 'keep2')), '正控：成功后原件必须消失');
    assertEquals(readFileSync(join(tp2, 'b.txt'), 'utf8'), 'B', '正控：副本必须完整');

    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/D2b 【平台】非特权环境下真实收尾失败：保留副本并如实报不确定', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // root 绕过 DAC 权限 ⇒ "只读父目录让 rm 失败"这个前提构造不出来。
      // 具名 SKIP，**不记 PASS**；恢复时不得把这一行改成 assert(true)。
      runner.noteSkip('running as root: chmod 0555 cannot make rm() fail (root bypasses DAC) — premise not constructible');
      return;
    }
    const tool = (await imp('plugins/tools/tool-rm.js')).default;
    const base = tempDir('d2b');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(join(ws, 'ro', 'keep'), { recursive: true });
    writeFileSync(join(ws, 'ro', 'keep/a.txt'), 'A');
    await tool.init(stubCore({ workDir: ws, stateDir }));
    const trashPath = join(stateDir, 'trash', 'keep_platform_test');

    const { chmod } = await import('node:fs/promises');
    await chmod(join(ws, 'ro'), 0o555);
    let err = null;
    try { await tool._moveAcrossDevices(join(ws, 'ro/keep'), trashPath); } catch (e) { err = e; }
    await chmod(join(ws, 'ro'), 0o755);

    assert(err, '原件删不掉时必须抛错，不得报成功');
    assertEquals(err.code, 'resource_error');
    assertEquals(err.rolled_back, false, '真实系统上同样：不得撤回唯一完整副本');
    assertEquals(readFileSync(join(trashPath, 'a.txt'), 'utf8'), 'A', '副本必须完整');
    assert(existsSync(join(ws, 'ro/keep/a.txt')), '原件必须原样还在');
    rmSync(base, { recursive: true, force: true });
  });

  runner.test('rc.23/D3 复制阶段失败：原件在、正式 trash 条目不存在、不留暂存残留', async () => {
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('mkfifo', ['--version']).error) { runner.noteSkip('mkfifo not available'); return; }
    const tool = (await imp('plugins/tools/tool-rm.js')).default;
    const base = tempDir('d3');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    // 反例形状（R23-C）：源目录里有 FIFO。`cp` 报 ERR_FS_CP_FIFO_PIPE ——
    // 修前异常发生在 `try { rm(original) }` **之前**，撤回逻辑根本不会跑：
    // 源目录还在，回收站里却出现了一个装着部分副本的正式条目。
    mkdirSync(join(ws, 'proj'), { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(ws, `proj/f${i}.txt`), `c${i}`);
    assertEquals(spawnSync('mkfifo', [join(ws, 'proj/pipe')]).status, 0, '前提：FIFO 必须建成功');
    await tool.init(stubCore({ workDir: ws, stateDir }));
    const trashPath = join(stateDir, 'trash', 'proj_cross_partial');

    let err = null;
    try { await tool._moveAcrossDevices(join(ws, 'proj'), trashPath); } catch (e) { err = e; }
    assert(err, '复制阶段失败必须抛错');
    assertEquals(err.code, 'resource_error', '具名 resource_error');
    assertEquals(err.rolled_back, true, '复制阶段失败：什么都还没删，必须报告已回滚');
    assertEquals(err.trash_entry_created, false, '回执必须说明没有产生正式回收站条目');
    assert(existsSync(join(ws, 'proj/f0.txt')), '原件必须原样还在');
    assert(!existsSync(trashPath), '正式回收站条目不得存在（不能留半份副本）');
    assert(!existsSync(`${trashPath}.partial`), '暂存目录必须被清掉，不得留残留');

    rmSync(base, { recursive: true, force: true });
  });

  // ── E：成员清单不得依赖外部 tar 的展示层转义 ──────────────────────
  runner.test('rc.23/E 成员清单必须原样读出 Unicode 名，不依赖 tar 的 quoting-style', async () => {
    const { listTgzFiles, listTgzMembers } = await imp('test/lib/tar-members.mjs');
    const { spawnSync } = await import('node:child_process');
    const base = tempDir('e');
    const pkgDir = join(base, 'package');
    mkdirSync(join(pkgDir, 'docs'), { recursive: true });
    const UNICODE = '文档-自审-复现.md';
    writeFileSync(join(pkgDir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    writeFileSync(join(pkgDir, 'docs', UNICODE), 'unicode body');
    const tgz = join(base, 'x.tgz');
    const mk = spawnSync('tar', ['-czf', tgz, '-C', base, 'package'], { encoding: 'utf8' });
    assert(mk.status === 0, `构造测试 tgz 失败：${(mk.stderr || '').slice(0, 120)}`);

    // **反例形状（这条用例存在的原因）**：GNU tar 的 `-t` 输出是面向终端的，
    // 在 C/POSIX locale 下会把非 ASCII 名转成八进制转义。实测本机：
    //   LC_ALL=C.UTF-8 → "package/docs/文档-自审-复现.md"
    //   LC_ALL=C       → "package/docs/\346\226\207\346\241\243-..."  ← 与登记清单永不相等
    // 也就是说：用 `tar -tzf` 的 stdout 做集合比对，判据的结论取决于跑它的人用的 locale。
    const escaped = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
    const escapedNames = escaped.stdout.split('\n').filter((l) => l && !l.endsWith('/'));
    const tarOutputIsLocaleDependent = escapedNames.some((n) => /\\[0-7]{3}/.test(n))
      || !escapedNames.some((n) => n.includes(UNICODE));
    if (tarOutputIsLocaleDependent) {
      // 这个环境下反例确实成立 —— 判据必须不受它影响。
      assert(!escapedNames.some((n) => n.endsWith(UNICODE)),
        '先确认反例成立：tar 在 C locale 下确实没给出原名');
    }

    // 判据：解析结果必须与归档内真实名字一致，与外部 tar 的引用方式无关。
    const names = listTgzFiles(readFileSync(tgz));
    assert(names.includes(`docs/${UNICODE}`),
      `Unicode 成员名必须原样读出（实际：${JSON.stringify(names)}；tar 在 C locale 下给出 ${JSON.stringify(escapedNames)}）`);
    const members = listTgzMembers(readFileSync(tgz));
    assertEquals(members.filter((m) => m.isDir).map((m) => m.name).sort().join(','), 'package,package/docs',
      '目录项必须被识别为目录，且不得混进文件清单');
    assert(!names.includes('package/docs'), '目录不得出现在文件清单里');
    // 正控：ASCII 成员同样被读出来。
    assert(names.includes('package.json'), 'ASCII 成员必须照常读出');

    rmSync(base, { recursive: true, force: true });
  });

  // ── F：压测汇总必须看见"套件崩了" ──────────────────────────────────
  runner.test('rc.23/F 套件以非零退出时汇总必须显式列出，不能只报"硬门禁失败 0"', async () => {
    // **为什么要真跑**：只看源码里有没有 `crashFailures` 这几个字，回注时把那行删掉
    // 或者保留变量却不用它，用例照样绿 —— 那是"文本存在"不是"行为存在"。
    // 这里真的让一个套件崩掉，然后检查 runner 打印出来的汇总行。
    //
    // 崩溃桩**不能**追加到真实 bench 文件末尾：`bench.finish()` 内部会 `process.exit()`，
    // 后面追加的代码永远执行不到（实测那样跑出来是 PASS，骗的是自己）。
    // 也不能"只有崩溃套件"：那样一个报告都不产出，runner 会正确地报「什么都没跑」并 exit 2
    // —— 那是另一条判据，会把这个用例变成测错东西。
    // 所以放两个一次性套件：一个正常产出报告，一个崩溃且不写报告。
    const { spawnSync } = await import('node:child_process');
    // 发布物形态：`test/stress/**` **不随包发布**（R0-122/T6 把“压测资产不进发布包”锁成硬门禁），
    // 而这条判据要真跑 `test/run-stress.mjs` + 两枚一次性套件。缺件时记 NOT_RUN（skip）：
    // 它不是“断言相反”，也不是“通过”—— 开发树里它必须真跑，发布物里它本来就不该在。
    if (!existsSync(join(ROOT, 'test', 'stress', 'lib', 'bench.mjs'))) {
      runner.noteSkip('仅源码检出：test/stress/ 不随包发布（R0-122/T6），此判据在开发树验证');
      return;
    }
    const probe = join(ROOT, 'test', 'stress', 'bench-rc23-crash-probe.mjs');
    const okProbe = join(ROOT, 'test', 'stress', 'bench-rc23-ok-probe.mjs');
    let out = '';
    let code = null;
    let okProbeRun = null;
    try {
      writeFileSync(okProbe, `import { Bench, parseArgs, selected } from './lib/bench.mjs';
const opts = parseArgs();
if (!selected(opts, 'L9')) process.exit(2);
const bench = new Bench('rc23-ok-probe', { title: 'rc.23 正常探针' });
bench.record({ id: 'L9-01', scene: '稳定的正常判据', metric: '数值', value: 0, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
bench.finish();
`);
      // 崩不崩由环境变量控制：同一个文件既能当"崩溃套件"也能当"正常套件"，
      // 这样正控与反例用的是**同一套基础设施**，差别只在被观测的行为上。
      writeFileSync(probe, `import { Bench, parseArgs, selected } from './lib/bench.mjs';
const opts = parseArgs();
if (!selected(opts, 'L9')) process.exit(2);
if (process.env.RC23_CRASH === '1') {
  // 崩溃形态：结论还没写下来就非零退出（模拟断言失败/未捕获异常）。
  console.error('rc23: 模拟套件崩溃（不写报告）');
  process.exit(1);
}
const bench = new Bench('rc23-crash-probe', { title: 'rc.23 第二探针' });
bench.record({ id: 'L9-02', scene: '稳定的正常判据', metric: '数值', value: 0, unit: 'count', kind: 'H', limit: 0, cmp: '==' });
bench.finish();
`);
      const r = spawnSync(process.execPath, [join(ROOT, 'test', 'run-stress.mjs'), '--quick', '--only=L9'], {
        encoding: 'utf8', cwd: ROOT, timeout: 300000,
        env: { ...process.env, RC23_CRASH: '1' },
      });
      out = `${r.stdout || ''}${r.stderr || ''}`;
      code = r.status;

      // 正控①：同一套探针、同一个 `--only=L9`，只是不崩溃 —— 汇总不得出现"套件级失败"，
      // 且必须 exit 0。**必须在这个 try 块内跑**：探针文件在 finally 里被删，
      // 挪到外面就变成了"跑一次没有探针的压测"（实测那次得到 exit 2，被误判成"正控失败"）。
      okProbeRun = spawnSync(process.execPath, [join(ROOT, 'test', 'run-stress.mjs'), '--quick', '--only=L9'], {
        encoding: 'utf8', cwd: ROOT, timeout: 300000,
        env: { ...process.env, RC23_CRASH: '0' },
      });
    } finally {
      rmSync(probe, { force: true });
      rmSync(okProbe, { force: true });
    }

    assert(out.includes('汇总'), `runner 必须打印汇总段；实际尾部：${out.slice(-400)}`);
    assert(out.includes('套件级失败'), `汇总必须显式给出"套件级失败"计数；实际尾部：${out.slice(-600)}`);
    assert(out.includes('SUITE-CRASH'), '失败明细里必须有可检索的崩溃条目');
    assert(out.includes('整体结论'), '汇总必须给出整体结论，而不只是分项计数');
    assertEquals(code, 1, '有套件崩溃时退出码必须是 1');

    const cleanOut = `${okProbeRun.stdout || ''}${okProbeRun.stderr || ''}`;
    assert(!cleanOut.includes('套件级失败'), `全绿时不得出现"套件级失败"字样；实际尾部：${cleanOut.slice(-400)}`);
    assertEquals(okProbeRun.status, 0, '全绿时 runner 必须 exit 0');

    // 正控②：退出码语义不能被"永远 exit 1"污染。
    const src = readFileSync(join(ROOT, 'test', 'run-stress.mjs'), 'utf8');
    assert(/if \(hFail > 0 \|\| crashed\.length\) process\.exit\(1\)/.test(src),
      '退出码判据必须同时看硬门禁失败与套件级失败');
    assert(/if \(hPass === 0 && recorded === 0\) process\.exit\(2\)/.test(src),
      '"什么都没跑"必须仍是 exit 2，不得被改成 1 或 0');
  });

  runner.test('rc.23/F2 网关压测必须在缺前提时自给前提，而不是把 503 记成"起不来"', async () => {
    if (!existsSync(join(ROOT, 'test', 'stress', 'bench-gateway.mjs'))) {
      runner.noteSkip('仅源码检出：test/stress/ 不随包发布（R0-122/T6），此判据在开发树验证');
      return;
    }
    const src = readFileSync(join(ROOT, 'test', 'stress', 'bench-gateway.mjs'), 'utf8');
    // 反例形状：/ready 的合同是"有 chat 能力 + 有可用模型配置"，缺 key 时按设计 503。
    // 旧版无条件等 200 ⇒ 前提没给被记成 L4-00 失败，掩盖真正的启动故障。
    assert(/TUSUNSUN_API_KEY/.test(src), '必须在缺前提时注入非密钥占位符以满足 readiness 合同');
    assert(/opts\.live/.test(src), '--live 时才该读真实凭证（占位符不得送往真实上游）');
    // 正控：仍然必须真的等 /ready 200 —— 不能因为要"消除假红"而把就绪判据整个去掉。
    assert(/waitFor\('\/ready 200'/.test(src), '就绪判据必须保留：真起不来仍然要红');
    // 正控：413 / fd / 稳态这些真实判据不得被删。
    for (const id of ['L4-03', 'L4-04', 'L4-06']) {
      assert(src.includes(id), `压测判据 ${id} 不得因为改前提而消失`);
    }
  });
}
