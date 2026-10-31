// rc.22：本轮清查里**实测复现**的八个缺陷，每个都配对称正控。
//
// 为什么每条都要有正控：只证明"缺陷形不会通过"是不够的 —— 那可能是判据整体坏了
//（`return false` 也能让反例变绿，同时把所有正常用法弄坏）。所以每条都是两种输入：
//   · 反例：修前的真实形态（如两个同名文件同毫秒删除）→ 判据必须报错/不丢；
//   · 正控：合法用法（如不同名文件、普通配置键）→ 判据必须照常放行。
// 两侧都成立，才说明判据落在**语义**上，不是落在"一律拒绝"上。
//
//   A  tool-rm 回收站命名碰撞：同名文件并发删除 ⇒ 静默永久丢失（P0，丢用户数据）
//   B  secrets.get 解密失败返回密文 ⇒ 密文被当 API key 发给上游（P0）
//   C  config 路径原型污染 ⇒ `Object.prototype` 被写、回显却报成功（P1）
//   D  tool-mv 静默覆盖目标 ⇒ 旧版本内容无声消失（P1）
//   E  destructive-gate 的 Map 只清过期项 ⇒ 短时大量不同命令时无界（P1）
//   F  tool-rm 回收站只增不减 ⇒ 磁盘无限增长（P1）
//   G  兜底层危险命令判据不传 cwd ⇒ 相对路径穿越绕过（P2）
//   H  context-budget 用 `kept.length===0` 判"没地方放任务" ⇒ 任务被丢仍报成功（P2）
//   I  json5 单引号串里的 `\'` 被原样搬运 ⇒ JSON.parse 报非法转义（P2）
//   J  sensitive-paths 的 verdict 缓存键漏 roots ⇒ 不同 whitelist 互相串味（P2）
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const imp = (rel) => import(join(ROOT, rel));

/** 每个案例一个独立临时目录，互不污染。 */
function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `rc22-${tag}-`));
}

async function makeRm({ stateDir, workDir }) {
  const tool = (await imp('plugins/tools/tool-rm.js')).default;
  await tool.init({
    stateDir, getData: () => workDir, getService: () => null,
    registerCapability() {}, log() {},
  });
  return tool;
}

export async function setup(runner) {
  // ── A：回收站命名碰撞 ───────────────────────────────────────────────
  runner.test('rc.22/A 同名文件并发删除不得互相覆盖（回收站的承诺是"可恢复"）', async () => {
    const base = tempDir('a');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(ws, { recursive: true });
    const tool = await makeRm({ stateDir, workDir: ws });

    // 反例形状：tool-executor 默认 _maxParallel=5，一次批量删 5 个不同目录下的同名文件。
    const CONTENTS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    for (let i = 0; i < CONTENTS.length; i++) {
      mkdirSync(join(ws, `mod${i}`), { recursive: true });
      writeFileSync(join(ws, `mod${i}`, 'index.js'), CONTENTS[i]);
    }
    const results = await Promise.all(
      CONTENTS.map((_, i) => tool.execute({ path: `mod${i}/index.js` })),
    );
    const paths = results.map((r) => r.trashed);
    assertEquals(new Set(paths).size, CONTENTS.length,
      '五个同名文件必须落进五个不同的回收站路径（修前是同一个，后到的覆盖先到的）');

    const trashDir = join(stateDir, 'trash');
    assertEquals(readdirSync(trashDir).length, CONTENTS.length, '回收站里必须真有五个条目');
    const saved = paths.map((p) => readFileSync(p, 'utf8')).sort();
    assertEquals(saved.join(','), [...CONTENTS].sort().join(','),
      '五份内容必须一份不少 —— 这正是"可恢复"的含义');

    // 正控：单个文件照常删得进回收站、内容可读回（判据不能靠"一律拒绝"变绿）。
    writeFileSync(join(ws, 'solo.txt'), 'solo');
    const solo = await tool.execute({ path: 'solo.txt' });
    assert(solo.ok, '普通文件必须仍能正常进回收站');
    assert(solo.trashed.startsWith(join(stateDir, 'trash') + '/'),
      '回收站路径必须落在本次实例的状态目录下');
    assertEquals(readFileSync(solo.trashed, 'utf8'), 'solo', '回收站里的内容必须可读回');
    rmSync(base, { recursive: true, force: true });
  });

  // ── B：解密失败不得把密文当明文 ─────────────────────────────────────
  runner.test('rc.22/B secrets 解不开时必须返回 null，不得交出密文', async () => {
    const { SecretsManager } = await imp('plugins/_lib/secrets.js');
    const stateDir = tempDir('b');
    const store = {};
    const mkCore = () => ({
      stateDir, log() {}, registerService() {},
      getService: () => ({ get: (k) => store[k], setAndSave: async (k, v) => { store[k] = v; } }),
    });

    // 反例形状：换 master key 后重启（等价于默认部署不设 SECRET_KEY 的每次重启）。
    process.env.TUSUNSUN_SECRET_KEY = 'rc22-key-A';
    const s1 = new SecretsManager(mkCore());
    await s1.set('model.apiKey', 'sk-THE-REAL-KEY');
    const cipher = store['model.apiKey'];
    assert(cipher.startsWith('{"iv":"'), '落盘的必须是密文包');

    process.env.TUSUNSUN_SECRET_KEY = 'rc22-key-B';
    const s2 = new SecretsManager(mkCore());
    const leaked = s2.get('model.apiKey');
    assertEquals(leaked, null, '解不开就是解不开：返回 null，不得把密文当明文（修前会把 {"iv":…} 当 Bearer token 发出去）');

    // 正控：key 一致时必须能读回明文（判据不能靠"永远返回 null"变绿）。
    process.env.TUSUNSUN_SECRET_KEY = 'rc22-key-A';
    const s3 = new SecretsManager(mkCore());
    assertEquals(s3.get('model.apiKey'), 'sk-THE-REAL-KEY', 'key 未变时必须照常读出明文');
    delete process.env.TUSUNSUN_SECRET_KEY;
    rmSync(stateDir, { recursive: true, force: true });
  });

  // ── C：config 路径原型污染 ──────────────────────────────────────────
  runner.test('rc.22/C 配置路径不得写进原型链；正常键必须照常写入', async () => {
    const { checkConfigPath, assignConfigPath, readConfigPath } = await imp('plugins/_lib/config-path.mjs');

    // 反例形状：修前 `__proto__.polluted` 会写 Object.prototype，而 JSON.stringify 不序列化原型
    // ⇒ 文件里什么都没有，回显却是"设置成功"。
    for (const bad of ['__proto__.polluted', 'constructor.prototype.x', 'a.__proto__', 'a..b', 'model.']) {
      const v = checkConfigPath(bad);
      assertEquals(v.ok, false, `非法路径必须被具名拒绝：${bad}`);
    }
    // 即便有人绕过 checkConfigPath 直接调 assign，也不能污染原型 —— 这条守的是"判据只有一份"。
    const probe = {};
    assignConfigPath(probe, ['safeKey'], 'v1');
    assertEquals(probe.safeKey, 'v1', '正常赋值必须生效');
    assertEquals(({}).polluted, undefined, 'Object.prototype 不得被污染');

    // 正控：真实配置键照常工作，且只认自有属性（不顺着原型链读）。
    const cfg = { model: { model: 'x' } };
    const good = checkConfigPath('model.apiKey');
    assert(good.ok, '正常路径必须通过');
    assignConfigPath(cfg, good.parts, 'sk-1');
    assertEquals(cfg.model.apiKey, 'sk-1', '嵌套写入必须生效');
    assertEquals(readConfigPath(cfg, good.parts), 'sk-1', '读回必须一致');
    assertEquals(readConfigPath({}, ['toString']), undefined, '读不得顺着原型链拿到 toString');
  });

  // ── D：tool-mv 不得静默覆盖 ─────────────────────────────────────────
  runner.test('rc.22/D tool-mv 默认拒绝覆盖已存在目标；显式 overwrite 才替换并交代旧文件', async () => {
    const base = tempDir('d');
    const ws = join(base, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'dst'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.txt'), 'NEW');
    writeFileSync(join(ws, 'dst', 'a.txt'), 'OLD-IMPORTANT');

    const tool = (await imp('plugins/tools/tool-mv.js')).default;
    await tool.init({ getData: () => ws, getService: () => null, registerCapability() {}, log() {} });

    // 反例形状：修前 rename 直接覆盖，返回 {ok:true}，旧内容无声消失。
    let refused = null;
    try { await tool.execute({ src: 'src/a.txt', dest: 'dst/a.txt' }); } catch (e) { refused = e; }
    assert(refused, '目标已存在时默认必须拒绝');
    assertEquals(refused.code, 'dest_exists', '拒绝必须是具名的 dest_exists，不是笼统失败');
    assertEquals(readFileSync(join(ws, 'dst', 'a.txt'), 'utf8'), 'OLD-IMPORTANT', '拒绝时旧文件必须原封不动');

    // 正控①：显式 overwrite 允许替换，且回执点名被替换的旧文件指纹。
    const ok = await tool.execute({ src: 'src/a.txt', dest: 'dst/a.txt', overwrite: true });
    assert(ok.ok, 'overwrite:true 时必须成功');
    assert(ok.replaced && typeof ok.replaced.sha256 === 'string',
      '替换必须在回执里点名被替换的旧文件（否则"刚才覆盖了什么"无法回放）');
    assertEquals(readFileSync(join(ws, 'dst', 'a.txt'), 'utf8'), 'NEW');

    // 正控②：目标不存在时照常移动，不受影响。
    writeFileSync(join(ws, 'src', 'b.txt'), 'B');
    const plain = await tool.execute({ src: 'src/b.txt', dest: 'dst/b.txt' });
    assert(plain.ok && !plain.replaced, '目标不存在时不应报 replaced');
    rmSync(base, { recursive: true, force: true });
  });

  // ── E：软闸 Map 必须有界 ────────────────────────────────────────────
  runner.test('rc.22/E destructive-gate 的待确认表必须有上界（只清过期项不算有界）', async () => {
    const gate = (await imp('plugins/_lib/destructive-gate.js')).default;
    const g = new gate();
    // 反例形状：TTL 内连着发大量**不同**的不可恢复命令。
    for (let i = 0; i < 300; i++) {
      g.check('tool-bash', { command: `rm file${i}.txt` }, '/tmp', { sessionId: 's1' });
    }
    assert(g._pending.size <= 128,
      `待确认表必须有上界，实测 ${g._pending.size}（修前会留下全部 300 条）`);

    // 正控：同一命令的挑战仍然有效 —— 上限不能靠"什么都不记"实现。
    const again = g.check('tool-bash', { command: 'rm kept.txt' }, '/tmp', { sessionId: 's2' });
    assert(again && again.challenge, '合法命令仍必须拿到挑战（判据不能退化成一律放行或一律拒绝）');
  });

  // ── F：回收站必须有界（有界 ≠ 自动删，见 rc.23/B）─────────────────────
  runner.test('rc.22/F 回收站必须对磁盘占用有界：越过水位要告警，清理需显式授权', async () => {
    const base = tempDir('f');
    const ws = join(base, 'ws');
    const stateDir = join(base, 'state');
    mkdirSync(ws, { recursive: true });
    const tool = await makeRm({ stateDir, workDir: ws });
    // 反例形状：连着删很多文件 —— 修前（rc.21 以前）回收站只增不减，磁盘会被悄悄写满。
    for (let i = 0; i < 620; i++) {
      writeFileSync(join(ws, `f${i}.txt`), 'x');
      await tool.execute({ path: `f${i}.txt` });
    }
    const n = readdirSync(join(stateDir, 'trash')).length;
    assertEquals(n, 620, '默认策略下不得自动删除任何条目（不可逆操作需要上层授权）');

    // 但"有界"这条判据必须仍然存在 —— 只是表达方式从"自动丢最旧的"改成"显式告警 + 可审计清理"：
    //   · 越过水位时回执必须告警（否则用户不知道盘在涨）；
    //   · 清理必须能被显式调用，且逐条留审计。
    writeFileSync(join(ws, 'latest.txt'), 'LATEST');
    const last = await tool.execute({ path: 'latest.txt' });
    assert(last.trash && last.trash.warning, '越过水位线后回执必须告警，不能对磁盘增长保持沉默');
    assert(last.trash.entries > last.trash.maxEntries, '告警必须给出当前条数与水位');
    assert(existsSync(last.trashed), '刚删的文件必须仍在回收站里 —— 任何清理都不得伤及最新一条');

    // 显式清理确实能释放空间（这才是"有界"的可执行出口）。
    const victim = join(stateDir, 'trash', readdirSync(join(stateDir, 'trash'))[0]);
    const old = new Date(Date.now() - 90 * 86400_000);
    (await import('node:fs')).utimesSync(victim, old, old);
    const pruned = await tool.prune({ maxAgeDays: 30 });
    assert(pruned.deleted.length >= 1, '显式 prune 必须真的删掉过期条目');
    assert(!existsSync(victim), '过期条目必须被真删（否则"有界"没有出口）');
    assert(existsSync(last.trashed), 'prune 不得删掉未过期的条目');
    rmSync(base, { recursive: true, force: true });
  });

  // ── G：兜底层判据必须按会话 cwd 解析相对路径 ────────────────────────
  runner.test('rc.22/G 执行器兜底层必须传会话 cwd，否则相对路径穿越绕过', async () => {
    const { matchDangerousCommand } = await imp('plugins/_lib/danger-patterns.js');
    // 反例形状：工作区在 /tmp/proj 时 `cat ../../../proc/self/environ` 真目标是 /proc/self/environ。
    const workDir = '/tmp/rc22-g-proj';
    const cmd = 'cat ../../../proc/self/environ';
    // 先证明这个形状确实"按 cwd 判"才有区别：不传 cwd 时（进程 cwd 不在 /tmp 下）落到别处。
    const withCwd = matchDangerousCommand(cmd, { cwd: workDir });
    assert(withCwd, '传 cwd 时必须能识别出它读的是 /proc');

    // 断言执行器**真的**把 cwd 传了下去：读源码里那一处调用形态。
    const src = readFileSync(join(ROOT, 'plugins/tool-executor.js'), 'utf8');
    assert(/matchBuiltinDangerousCommand\(\s*cmd\s*,\s*\{\s*cwd:/.test(src),
      '执行器兜底层必须在调用时传 cwd（修前是 matchBuiltinDangerousCommand(cmd)，相对路径按 process.cwd() 解析）');

    // 正控：普通命令不得被误拦。
    assertEquals(matchDangerousCommand('cat README.md', { cwd: workDir }), null,
      '工作区内的普通读取不得被拦');
  });

  // ── H：预算判据要看"任务有没有留下" ────────────────────────────────
  runner.test('rc.22/H 预算裁剪不得丢掉任务却报成功；正常裁剪必须仍然成功', async () => {
    const { enforceBudget } = await imp('plugins/_lib/context-budget.js');

    // 反例形状①：末尾一对 assistant+tool（工具刚执行完、下一次模型调用前）。
    const withTool = [
      { role: 'system', content: 'HOST' },
      { role: 'user', content: 'THE-TASK-' + 'y'.repeat(6000) },
      { role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name: 'tool-read', arguments: '{}' } }] },
      { role: 'tool', content: 'file content' },
    ];
    const r1 = enforceBudget({ messages: withTool, limit: 150, reserve: 0 });
    assertEquals(r1.ok, false, '任务被丢光时必须具名失败（修前 kept 含 tool 消息 ⇒ 报成功）');
    assertEquals(r1.code, 'context_budget_exceeded', '失败必须是具名的 context_budget_exceeded');

    // 反例形状②：中间/末尾插入 system（plugin-context 的 extras 就是这样 splice 进来的）。
    const withSystem = [
      { role: 'system', content: 'HOST' },
      { role: 'user', content: 'THE-TASK-' + 'y'.repeat(4000) },
      { role: 'system', content: 'INJECTED-CTX-' + 'z'.repeat(50) },
    ];
    const r2 = enforceBudget({ messages: withSystem, limit: 200, reserve: 0 });
    assertEquals(r2.ok, false, '只留下 system 与注入上下文、任务被丢时，同样必须失败');

    // 正控：预算够时正常裁剪，当前任务必须在保留集里。
    const normal = [
      { role: 'system', content: 'HOST' },
      { role: 'user', content: 'OLD-' + 'a'.repeat(3000) },
      { role: 'assistant', content: 'reply-' + 'b'.repeat(3000) },
      { role: 'user', content: 'CURRENT-' + 'c'.repeat(300) },
    ];
    const r3 = enforceBudget({ messages: normal, limit: 600, reserve: 0 });
    assert(r3.ok, '正常的超预算裁剪必须仍然成功（判据不能退化成一律失败）');
    assert(r3.messages.some((m) => String(m.content).startsWith('CURRENT')),
      '裁剪后当前任务必须还在');
    rmSync(tempDir('h'), { recursive: true, force: true });
  });

  // ── I：json5 单引号串里的 \' ────────────────────────────────────────
  runner.test('rc.22/I json5 单引号串必须支持 \\\' 转义；双引号串行为不变', async () => {
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    // 反例形状：JSON5 合法写法 `'it\'s'`，修前被原样搬进 JSON ⇒ Bad escaped character。
    assertEquals(loadJson5(`{ a: 'it\\'s ok' }`).a, "it's ok", '单引号串里的 \\\' 必须解成字面单引号');
    // 正控：其余转义与双引号串行为必须不变。
    assertEquals(loadJson5(`{ a: 'line1\\nline2' }`).a, 'line1\nline2', '单引号串里的 \\n 仍是换行');
    assertEquals(loadJson5(`{ a: "it's" }`).a, "it's", '双引号串内含单引号仍合法');
    assertEquals(loadJson5(`{ a: 'he said "hi"' }`).a, 'he said "hi"', '单引号串内的双引号仍被转义');
  });

  // ── J：verdict 缓存键必须含 roots ──────────────────────────────────
  runner.test('rc.22/J 敏感路径判定缓存必须按 roots 区分，不能串味', async () => {
    const { sensitivePathOf, pathCache } = await imp('plugins/_lib/sensitive-paths.js');
    const cache = pathCache();
    const raw = '/tmp/rc22-j.txt';
    // 反例形状：同一个 cache 里换 roots 再判同一路径（修前第二次直接命中第一次的结论）。
    const a = sensitivePathOf(raw, { cache, roots: ['/tmp'] });
    const b = sensitivePathOf(raw, { cache, roots: ['/var'] });
    assertEquals(a, '/tmp', 'roots=[/tmp] 时必须命中 /tmp');
    assertEquals(b, null, 'roots=[/var] 时不得沿用上一条结论（键里必须含 roots）');
    // 正控：同一 roots 重复判定结论必须稳定（缓存确实在工作，没有退化成每次都算）。
    assertEquals(sensitivePathOf(raw, { cache, roots: ['/tmp'] }), '/tmp', '同一 roots 重复判定必须一致');
    assertEquals(sensitivePathOf(raw, { cache, roots: ['/var'] }), null, '同一 roots 重复判定必须一致');
  });
}
