/**
 * F05 `@host` 掌权路径探针 —— 把送审文档里的反例钉成可重跑的东西，并验证**修后**行为。
 *
 * 为什么单独一个文件：这条反例**不需要任何内部 API**，插件在 `init(c)` 里拿到的 `c`
 * 就是 Core 本体。所以它不属于「同进程恶意 JS」那种已被合同 §4 前提 1 排除的场景，
 * 而是**公开 API 的判据写错了**：匿名（`claimant == null`）被当成了宿主。
 *
 * 合同依据（`contracts/capability-identity-v1.md` §5，规范栏）：
 *   宿主接管需要真实宿主能力或受信上下文；**不得仅因 `claimant == null` 推断为宿主**，
 *   也不得仅因名字等于 `@host` 就认作宿主。
 *
 * 修前（rc.15 送审时）实测：`F05-HOST-01` / `02` 为 BROKEN ——
 * 一次 `registerService('db', 攻击者的对象, { takeover: true })` 就把受害者服务换成
 * `@host`，并在受害者卸载后残留。
 *
 * 专家裁定 **A'** 之后（宿主控制能力只由构造期领取，Core 公开面不发证），
 * 本探针的**判据不变**，变的是它现在应当全部 FIXED：
 *   · 01/02 的攻击调用必须被**具名拒绝**（`host_authority_required`），服务与归属不变；
 *   · 02 额外确认「受害者卸载后服务确实被正常清掉」——修复不能靠"什么都不删"来实现；
 *   · 03 是**正控**：合法宿主接管经 `createRuntime()` 交出的 `host` 仍必须成功且留痕。
 *     deny-all 也能让 01/02 变绿，那不是安全，是把功能做没了（同 m10/m11 的教训）。
 *
 * 用法：`node verification/counterexamples/f05-host-takeover.mjs [package根目录]`
 * 退出码：0 = 全部 FIXED；1 = 仍有 BROKEN；2 = 探针自身出错。
 *
 * 本文件**故意不在** `test/probes/`：`release-gate` 会按退出码跑那个目录里的每一个，
 * 而本文件描述的是「曾经坏过」的证据，不是发布门禁的一部分。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const ROOT = mkdtempSync(join(tmpdir(), 'f05-host-'));

const results = [];
const probe = async (id, title, fn) => {
  try {
    const r = await fn();
    results.push({ id, title, status: r.ok ? 'FIXED' : 'BROKEN', detail: r.detail });
  } catch (e) {
    results.push({ id, title, status: 'PROBE-ERROR', detail: String(e?.stack || e) });
  }
};
const imp = (rel) => import(pathToFileURL(join(PKG, rel)).href);

const { createRuntime } = await imp('src/core/core.js');
const { LifecycleManager } = await imp('src/core/lifecycle-manager.js');

let seq = 0;
/** 每个用例一个独立运行时：`core` 给插件看，`host` 只留在测试手里。 */
const makeRuntime = () => {
  seq += 1;
  const { core, host } = createRuntime({ stateDir: join(ROOT, `state-${seq}`) });
  core.log = () => {};
  core._stopAssemblyDrainMs = 20;
  return { core, host };
};
const pluginOf = (name, extra = {}) => ({
  name, version: '1.0.0', async init() {}, async start() {}, async stop() {}, ...extra,
});

/** 只记错误码：被拒绝是**期望**，不是探针失败。 */
const codeOf = (fn) => {
  try { fn(); return null; } catch (e) { return e?.code ?? `(no code) ${e?.message}`; }
};

/**
 * F05-HOST-01：插件持有 Core 引用（`init(c)` 给的）就能把别人已归属的服务换成自己的，
 * 并把 owner 改成 `@host`。这是「匿名 ⇒ 宿主」的直接后果。
 * 修后：必须被 `host_authority_required` 具名拒绝，对象与归属都不变。
 */
await probe('F05-HOST-01', '匿名 takeover 不得把他人服务改归 @host（合同 §5 明令禁止）', async () => {
  const { core } = makeRuntime();
  const lc = new LifecycleManager(core);
  try {
    await lc.load(pluginOf('victim', {
      async init(c) { c.registerService('db', { query: () => 'victim' }); },
    }), core, {});
    const ownerBefore = core.getServiceOwnership('db')?.owner;

    // 攻击者只做一件合法的事：在 init 里把 core 引用存下来。
    const attacker = pluginOf('attacker', { _c: null, async init(c) { this._c = c; } });
    await lc.load(attacker, core, {});
    // 装载结束、ALS 已退出，此刻 claimant 为 null。
    const code = codeOf(() => attacker._c.registerService('db', { query: () => 'ATTACKER' }, { takeover: true }));

    const ownerAfter = core.getServiceOwnership('db')?.owner;
    const swapped = core.getService('db')?.query?.() === 'ATTACKER';
    const ok = code === 'host_authority_required' && !swapped && ownerAfter === ownerBefore;
    return {
      ok,
      detail: `拒绝码=${code ?? '(未拒！)'}；owner ${ownerBefore} -> ${ownerAfter}；`
        + `服务对象被替换=${swapped}（合同 §5：不得仅因 claimant == null 推断为宿主）`,
    };
  } finally { await core.stop().catch(() => {}); }
});

/**
 * F05-HOST-02：二次伤害 —— 抢来的 `@host` 服务，受害者卸载后仍然在。
 * `@host` 条目按设计「不得被任何插件按名拆走」，于是一次 takeover 就造出一块
 * 生命周期清不掉的飞地。
 * 修后：攻击被拒 ⇒ 服务归属仍是受害者 ⇒ 受害者卸载后该服务**正常消失**。
 * 后半句是反向判据：修复不得靠"什么都不删"来实现。
 */
await probe('F05-HOST-02', '被抢成 @host 的服务，受害者卸载后不得残留', async () => {
  const { core } = makeRuntime();
  const lc = new LifecycleManager(core);
  try {
    await lc.load(pluginOf('victim', {
      async init(c) { c.registerService('db', { query: () => 'victim' }); },
    }), core, {});
    const attacker = pluginOf('attacker', { _c: null, async init(c) { this._c = c; } });
    await lc.load(attacker, core, {});
    const code = codeOf(() => attacker._c.registerService('db', { query: () => 'ATTACKER' }, { takeover: true }));

    const ownerAfterAttack = core.getServiceOwnership('db')?.owner;
    await lc.unload('victim');
    const remains = core._services.has('db');
    // 两个条件都要：攻击没生效（归属没变）+ 正常清场仍然有效（服务真的没了）。
    const ok = code === 'host_authority_required' && ownerAfterAttack === 'victim' && !remains;
    return {
      ok,
      detail: `拒绝码=${code ?? '(未拒！)'}；攻击后 owner=${ownerAfterAttack}；`
        + `unload(victim) 后 _services.has('db')=${remains}（应为 false：正常清场仍须生效）`,
    };
  } finally { await core.stop().catch(() => {}); }
});

/**
 * F05-HOST-03【正控】：**合法**的宿主接管必须仍然可行。
 *
 * 这一条是防止上面两条被"一律禁止 takeover"糊过去 —— deny-all 也能让它们变绿，
 * 那不是安全，是把宿主接管功能做没了（同 m10/m11 的教训）。
 */
await probe('F05-HOST-03', '【正控】宿主经 createRuntime 的 host 接管仍须成功且留痕', async () => {
  const { core, host } = makeRuntime();
  try {
    await core._runAssemblyContext('owner-a', async () => {
      core.registerService('svc', { v: 'A' });
    }, core.assemblyEpoch);
    await host.takeoverService('svc', { v: 'H' }, { reason: 'bootstrap-recovery' });
    const own = core.getServiceOwnership('svc');
    const ok = own?.owner === '@host' && core.getService('svc')?.v === 'H'
      && own?.takeover?.previousOwner === 'owner-a' && own?.takeover?.actorClass === 'host';
    return {
      ok,
      detail: `owner=${own?.owner} from=${own?.takeover?.previousOwner} actorClass=${own?.takeover?.actorClass}`
        + '（正控：修法不得把宿主接管一并禁掉）',
    };
  } finally { await core.stop().catch(() => {}); }
});

const fixed = results.filter((r) => r.status === 'FIXED').length;
const broken = results.filter((r) => r.status === 'BROKEN').length;
const errored = results.filter((r) => r.status === 'PROBE-ERROR').length;

console.log('\n══════════ F05 @host 掌权路径探针 ══════════\n');
for (const r of results) {
  console.log(`${r.status.padEnd(11)} ${r.id.padEnd(12)} ${r.title}`);
  console.log(`            ${r.detail}`);
}
console.log(`\n合计 ${results.length}｜FIXED ${fixed}｜BROKEN ${broken}｜PROBE-ERROR ${errored}\n`);
console.log('修前状态与裁定过程：docs/quality/f05-host-takeover-ruling.md');
console.log('裁决 A\' 的实现判据：test/unit/test-f05-host-authority-matrix.test.mjs（H01–H18）');
console.log('模型侧：verification/model/HostControl.tla（m12/m13/m14 三项突变全杀）\n');

rmSync(ROOT, { recursive: true, force: true });
if (errored) process.exitCode = 2;
else if (broken) process.exitCode = 1;
