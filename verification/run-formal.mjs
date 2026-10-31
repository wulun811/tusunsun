#!/usr/bin/env node
/**
 * verification/run-formal.mjs —— 形式化验证的双轨入口（专家合同 §7/§8）
 *
 * 跑两件事，各写自己的报告：
 *   1. 模型轨：`model/Lifecycle.tla` + `model/Ownership.tla`，各自参考 cfg 与突变体 cfg → TLC
 *   2. 实现轨：`verification/adapter/replay.mjs` 跑真实 src/ → 逐条重放记录
 *
 * 状态词只用合同 §7 里的七个。特别地：
 *   · 缺 JDK / 缺 tla2tools.jar / jar 的 sha256 与 pin 不符 ⇒ 全部 `NOT_RUN`，**不**写 PASS；
 *   · 参考模型跑不出错 ⇒ `MODEL_PASS_BOUNDED`（有界、指定范围），不是「已验证」；
 *   · 突变体找不到反例 ⇒ `MODEL_INCONCLUSIVE` + `sensitivity: SURVIVED`，并且退出码 1 ——
 *     模型杀不死已知坏行为，说明模型是空的，这比没有模型更危险。
 *
 * 用法：
 *   node verification/run-formal.mjs             # 缺工具时 advisory：写 NOT_RUN，退出 0
 *   node verification/run-formal.mjs --strict    # 缺工具也退出 2（给 nightly 用）
 *   TLA2TOOLS_JAR=/path/to/tla2tools.jar node verification/run-formal.mjs
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runReplay, REPO } from './adapter/replay.mjs';
import { sourceProvenance } from './lib/provenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(HERE, 'model');
const TLA = join(MODEL_DIR, 'Lifecycle.tla');
/** 本轮新增的第二个模型。两份模型各自有 cfg 与突变体，不共用状态空间。 */
const OWNERSHIP = join(MODEL_DIR, 'Ownership.tla');
/** F05 服务侧接管子模型（专家裁决 A' §6）：小范围，只问"谁能换掉已归属的服务"。 */
const HOSTCONTROL = join(MODEL_DIR, 'HostControl.tla');
/** F06 依赖与停机次序：问的是**图**（谁依赖谁、凭什么顺序、排不出序时怎么说）。
 * 与 Lifecycle 分开是因为后者问的是锁与在途尝试，混在一张表里两边的反例互相掩盖。 */
const DEPENDENCY = join(MODEL_DIR, 'Dependency.tla');
/** 服务登记身份：问的是「撤销一笔登记时，凭据是否还指向当前这一笔」。
 * 与 HostControl 分开，是因为后者问「谁能把一条已归属的服务换掉」——同一句 compare-and-delete
 * 在两个方向上都能错，而两种错法的反例形状不同。 */
const SERVICEREG = join(MODEL_DIR, 'ServiceRegistration.tla');
const JAR = process.env.TLA2TOOLS_JAR || join(MODEL_DIR, '.tools', 'tla2tools.jar');
const PIN_FILE = join(MODEL_DIR, 'tla2tools.jar.sha256');
const REPORTS = join(HERE, 'reports');
/** 报告要写清自己描述的是哪棵树。verification/ 不进树摘要，所以把报告提交进去不会改变它。 */
const REPO_ROOT = join(HERE, '..');
/**
 * 四份模型的身份表：报告里的 `models[]` 从**这一处**生成。
 *
 * 此前 `models[]` 是手写的三行字面量。加第四份模型（Dependency/F06）时忘了同步，
 * 于是 `per_model` 有四份、`models` 只有三份 —— 两个字段各说各话，而没有任何东西
 * 要求它们相等。清单抄两份，第二份一定会漂，而且漂了不会报错。
 */
const MODEL_FILES = [
  { name: 'Lifecycle', file: TLA, contracts: ['F03', 'F04', 'F05', 'F08'] },
  { name: 'Ownership', file: OWNERSHIP, contracts: ['F01'] },
  { name: 'HostControl', file: HOSTCONTROL, contracts: ['F05'] },
  { name: 'Dependency', file: DEPENDENCY, contracts: ['F06'] },
  { name: 'ServiceRegistration', file: SERVICEREG, contracts: ['F01', 'F05', 'F07'] },
];
const STRICT = process.argv.includes('--strict');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const rel = (p) => relative(REPO, p).split('\\').join('/');

/** 合同 §3 的范围，写进报告：什么被穷举了，必须和没被穷举的一起看。 */
const SCOPE = {
  Lifecycle: {
    plugins: ['A', 'B'], waiters: ['W1', 'W2'], max_epoch: 3,
    one_lock_key: true, one_attempt: true, one_stop_fault: true,
    note: '只穷举这些维度上的所有交错；不是对任意插件数/任意上界的证明',
  },
  Ownership: {
    instances: ['X1', 'X2'], handles: ['hA', 'hB'], max_registrations: 2,
    one_capability_name: true, one_late_stop: true,
    note: '两个实例、两笔登记、两枚句柄。不覆盖：句柄保密性、服务侧登记、进程隔离',
  },
  HostControl: {
    instances: ['V1', 'V2'], max_registrations: 2, one_service_name: true, one_late_unload: true,
    note: '两个插件实例、一个 HostControl、一个服务名。不覆盖：控制体保密性、接管时的在途依赖效果、进程隔离',
  },
  /**
   * 服务登记身份的边界。没有 `shapes`：它不是图模型，没有「声明过的形状」需要核对，
   * `checkScopeCoverage` 会按既有的 `if (!Array.isArray(scope.shapes)) continue` 跳过它。
   */
  ServiceRegistration: {
    attempts: ['a1', 'a2'], max_registrations: 3, one_service_name: true,
    note: '两笔装配 attempt、一个服务名、登记编号上界 3。不覆盖：多服务名、并发线程（提交在 JS 里是同步原子段）、进程隔离',
  },
  /**
   * F06 的**有限边界**必须写清楚，不能只说“四模型有限通过”。
   *
   * 这里逐 shape 列出节点、边、环数、分量数，以及失败预算（同时能坏几个 stop）。
   * `shapes` 里的每一项都必须在 `scenarios` 里**真的跑过**（见 `checkScopeCoverage`）：
   * 声明一个没跑过的 shape，就等于用“已通过”替了真实验收。
   *
   * 为什么必须有 `two-cycles-linked`：只有一个环时，“同一个 SCC”与“出现在任意一个
   * 环里”两种豁免写法结果**完全一样**，模型对 R15-01 那个错误不可能敏感。
   */
  Dependency: {
    shapes: ['chain', 'no-live', 'two-cycles-linked'],
    plugins: {
      chain: ['a', 'b', 'c'],
      'no-live': ['a', 'b', 'c'],
      'two-cycles-linked': ['a', 'b', 'c', 'd'],
    },
    edges: {
      chain: ['a->c', 'b->a', 'b->ghost', 'c->a'],
      'no-live': ['b->ghost'],
      'two-cycles-linked': ['a->b', 'b->a', 'c->d', 'd->c', 'c->a'],
    },
    components: { chain: 2, 'no-live': 3, 'two-cycles-linked': 2 },
    cycles: { chain: 1, 'no-live': 0, 'two-cycles-linked': 2 },
    max_stop_faults_per_run: 1,
    ghost_kinds: ['premature', 'fake_basis', 'silent_unresolved', 'silent_cycle'],
    note: '每个 shape 最多 4 个插件、一个“stop() 到点不返回”的环境动作；只穷举这些维度。'
      + '不覆盖：环检测算法本身、任意插件数/任意形状、停机的外部副作用、进程隔离',
  },
};

const SCENARIOS = [
  { model: 'Lifecycle', id: 'reference-stopfault', kind: 'reference', cfg: 'Lifecycle.cfg', stopFault: true },
  { model: 'Lifecycle', id: 'reference-nofault', kind: 'reference', cfg: 'Lifecycle.nofault.cfg', stopFault: false },
  {
    id: 'm1-timeout-releases-lease', kind: 'mutant', contract: 'F03', cfg: 'mutants/m1-timeout-releases-lease.cfg',
    expect: 'INV_F03_LEASE', deviation: 'WaitTimeout 顺手清掉真实 attemptLease（专家 §4 第 1 条）', refers_to: null,
  },
  {
    model: 'Lifecycle',
    id: 'm2-late-commit-without-epoch', kind: 'mutant', contract: 'F05', cfg: 'mutants/m2-late-commit-without-epoch.cfg',
    expect: 'INV_F05_NO_STALE_WRITE', deviation: '旧代提交不看 epoch guard（专家 §4 第 2 条）', refers_to: null,
  },
  {
    model: 'Lifecycle',
    id: 'm3-waiter-timeout-releases-lock', kind: 'mutant', contract: 'F04', cfg: 'mutants/m3-waiter-timeout-releases-lock.cfg',
    expect: 'INV_F04_MUTEX', deviation: '等锁超时者释放了别人的锁（专家 §4 第 3 条）', refers_to: 'H7',
  },
  {
    model: 'Lifecycle',
    id: 'm4-stop-deadline-claims-stopped', kind: 'mutant', contract: 'F08', cfg: 'mutants/m4-stop-deadline-claims-stopped.cfg',
    expect: 'INV_F08_NO_FAKE_STOPPED', deviation: '期限到了就宣称「已停」（专家 §2 禁止写法二）', refers_to: 'H8',
  },
  {
    model: 'Lifecycle',
    id: 'm5-no-stop-deadline', kind: 'mutant', contract: 'F08', cfg: 'mutants/m5-no-stop-deadline.cfg',
    expect: 'DEADLOCK', deviation: '停机根本没有期限，只有无限等（H8 修前形状）', refers_to: 'H8',
  },
  // ── F01 Ownership（专家 S6 裁决 §6 的最小模型：两实例 / 一能力名 / R1,R2 / H1,H2 / 一次迟到 stop）
  { model: 'Ownership', id: 'reference-ownership', kind: 'reference', cfg: 'Ownership.cfg' },
  // ── F06 Dependency（两个参考 shape：有活边的一条、连一条活边都没有的一条）
  { model: 'Dependency', id: 'reference-dependency-chain', kind: 'reference', cfg: 'Dependency.cfg' },
  {
    model: 'Dependency', id: 'reference-dependency-twocycles', kind: 'reference',
    cfg: 'Dependency.twocycles.cfg',
    note: 'Shape=two-cycles-linked：两个独立环 + 一条跨环的真实依赖 c→a（R15-01 的形状）',
  },
  {
    model: 'Dependency', id: 'reference-dependency-nolive', kind: 'reference',
    cfg: 'mutants/m20-dependency-no-live-reference.cfg',
    note: 'Shape=no-live：只有一条指向缺席提供者的边 —— 仍是参考模型（Mutant=none）',
  },
  {
    model: 'Dependency', id: 'm15-release-under-stuck-dependent', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m15-release-under-stuck-dependent.cfg',
    expect: 'INV_F06_NO_PREMATURE_RELEASE',
    deviation: '依赖方 stop 超时（stuck，仍可能在跑）后，提供方照停 —— `_stopLocked` 不回头检查依赖方是否真停了',
    refers_to: 'R0-032/1',
  },
  {
    model: 'Dependency', id: 'm16-insertion-as-topology', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m16-insertion-as-topology.cfg',
    expect: 'INV_F06_BASIS_FAITHFUL',
    deviation: '没有任何已装载提供者的依赖边，却自报 basis=dependency（拿插入序冒充拓扑序）',
    refers_to: 'F06-REPLAY/2',
  },
  {
    model: 'Dependency', id: 'm17-swallow-unresolved', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m17-swallow-unresolved.cfg',
    expect: 'INV_F06_NO_SILENT_UNRESOLVED', deviation: '缺席的提供者被静默吞掉，不交出去', refers_to: 'F06-REPLAY/3',
  },
  {
    model: 'Dependency', id: 'm18-swallow-cycle', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m18-swallow-cycle.cfg',
    expect: 'INV_F06_NO_SILENT_CYCLE', deviation: '环不报，直接跳过出顺序', refers_to: 'F06-REPLAY/4',
  },
  {
    model: 'Dependency', id: 'm21-cross-scc-exemption', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m21-cross-scc-exemption.cfg',
    expect: 'INV_F06_NO_PREMATURE_RELEASE',
    deviation: '环豁免写成“出现在任意一个环里”而非“同一个 SCC”：两个环之间的真实依赖边被豁免，依赖方还在跑就停了提供方',
    refers_to: 'R15-01 / R0-032/5',
  },
  {
    model: 'Dependency', id: 'm19-deny-all-stop', kind: 'mutant', contract: 'F06',
    cfg: 'mutants/m19-deny-all-stop.cfg',
    expect: 'INV_F06_STOP_ENABLED',
    deviation: '停机一律发不出去 —— "永远别停"也能让安全问题全绿（正例不许丢）', refers_to: null,
  },
  // ── F05 HostControl（专家裁决 A' §6：小范围服务接管子模型）
  { model: 'HostControl', id: 'reference-hostcontrol', kind: 'reference', cfg: 'HostControl.cfg' },
  {
    model: 'HostControl', id: 'm12-host-null-claimant', kind: 'mutant', contract: 'F05',
    cfg: 'mutants/m12-host-null-claimant.cfg',
    expect: 'INV_F05_HOST_ONLY_BY_CONTROL', deviation: '恢复 claimant == null 即视作宿主', refers_to: 'H01/H02',
  },
  {
    model: 'HostControl', id: 'm13-host-trusted-is-host', kind: 'mutant', contract: 'F05',
    cfg: 'mutants/m12-host-trusted-is-host.cfg',
    expect: 'INV_F05_HOST_ONLY_BY_CONTROL', deviation: '受信装配上下文（asm.trusted）即视作宿主', refers_to: 'H03',
  },
  {
    model: 'HostControl', id: 'm14-host-release-by-name', kind: 'mutant', contract: 'F05',
    cfg: 'mutants/m12-host-release-by-name.cfg',
    expect: 'INV_F05_OLD_UNLOAD_KEEPS_R2', deviation: '按服务名释放而不是按登记身份（旧实例可拆走 R2）', refers_to: 'H11/H12',
  },
  // ── F01/F05/F07 服务登记身份（R16-01 §5：撤销一笔登记时凭据必须仍指向当前这一笔）
  { model: 'ServiceRegistration', id: 'reference-service-registration', kind: 'reference', cfg: 'ServiceRegistration.cfg' },
  {
    model: 'ServiceRegistration', id: 'm22-cleanup-by-name', kind: 'mutant', contract: 'F01',
    cfg: 'mutants/m22-cleanup-by-name.cfg',
    expect: 'INV_SR_NO_DANGLING_ID',
    deviation: '失败装配的清理按服务名删、且只清对象与归属，留着登记 ID 与接管回执 —— 对象没了但账号还在',
    refers_to: 'R16-01 / R16-02',
  },
  {
    model: 'ServiceRegistration', id: 'm23-release-by-orphan-id', kind: 'mutant', contract: 'F05',
    cfg: 'mutants/m23-release-by-orphan-id.cfg',
    expect: 'INV_SR_CLEANUP_NO_WRONG_DELETE',
    deviation: '释放只问「这个编号曾经发过没有」，不拿它跟当前那一笔比对 —— 旧 ID 能拆掉新登记',
    refers_to: 'R16-01e',
  },
  {
    model: 'Ownership', id: 'm6-release-by-id', kind: 'mutant', contract: 'F01', cfg: 'mutants/m6-release-by-id.cfg',
    expect: 'INV_F01_NO_ABA',
    deviation: '释放只判"这是个真句柄"，不判它是否仍指向当前那笔 —— delete(name) 而非 compare-and-delete(id)',
    refers_to: 'E-3',
  },
  {
    model: 'Ownership', id: 'm7-release-by-string', kind: 'mutant', contract: 'F01', cfg: 'mutants/m7-release-by-string.cfg',
    expect: 'INV_F01_NO_STRING_AUTH', deviation: '释放凭公开字符串过关（E-3：releaseCapability(id, ownerString)）', refers_to: 'E-3',
  },
  {
    model: 'Ownership', id: 'm8-late-reap-by-name', kind: 'mutant', contract: 'F01', cfg: 'mutants/m8-late-reap-by-name.cfg',
    expect: 'INV_F01_REAP_SCOPED', deviation: '旧实例的迟到清场按插件名删（重载后同名）', refers_to: 'ID-10',
  },
  {
    model: 'Ownership', id: 'm9-owner-string-override', kind: 'mutant', contract: 'F01', cfg: 'mutants/m9-owner-string-override.cfg',
    expect: 'INV_F01_NO_STRING_AUTH', deviation: '覆盖凭"声明 owner 字符串相等"过关', refers_to: null,
  },
  {
    model: 'Ownership', id: 'm10-deny-all-release', kind: 'mutant', contract: 'F01', cfg: 'mutants/m10-deny-all-release.cfg',
    expect: 'INV_F01_RELEASE_ENABLED',
    deviation: '释放一律拒绝 —— "不许卸载"也能让安全问题全绿（专家回函：正例不许丢）', refers_to: null,
  },
  {
    model: 'Ownership', id: 'm11-deny-all-reap', kind: 'mutant', contract: 'F01', cfg: 'mutants/m11-deny-all-reap.cfg',
    expect: 'INV_F01_REAP_ENABLED', deviation: '清场一律空转 —— 插件永远卸不干净', refers_to: null,
  },
];

/** 从 TLC 输出里只取它真写下的东西；没有的不猜。 */
function parseTlc(out) {
  const noError = /Model checking completed\. No error has been found\./.test(out);
  const inv = out.match(/Invariant (\w+) is violated/);
  const temporal = out.match(/Temporal property (\w+) is violated/);
  const deadlock = /Error: Deadlock reached\./.test(out);
  const num = (re) => {
    const m = out.match(re);
    return m ? Number(String(m[1]).replace(/,/g, '')) : null;
  };
  const trace = [...out.matchAll(/^State (\d+): <([A-Za-z][A-Za-z0-9_]*)/gm)]
    .map((m) => m[2]).filter((a) => a !== 'Initial');
  const property = inv ? inv[1] : temporal ? temporal[1] : deadlock ? 'DEADLOCK' : null;
  return {
    pass: noError,
    property,
    states_generated: num(/([\d,]+) states generated/),
    distinct_states: num(/([\d,]+) distinct states found/),
    depth: num(/depth of the complete state graph search is (\d+)/),
    trace,
    tlc_version: (out.match(/TLC2 Version (\S+)/) || [])[1] ?? null,
  };
}

function runTlc(scenario) {
  const metadir = join(tmpdir(), `tlc-${process.pid}-${scenario.id}`);
  rmSync(metadir, { recursive: true, force: true });
  const tla = scenario.model === 'Ownership' ? OWNERSHIP
    : scenario.model === 'HostControl' ? HOSTCONTROL
      : scenario.model === 'Dependency' ? DEPENDENCY
        : scenario.model === 'ServiceRegistration' ? SERVICEREG : TLA;
  // **不加 `-nowarning`**：它会把 `x' = x \/ y` 这类语义错误一起吞掉。
  // Ownership.tla 的第一版就是这么绿的（TLC 静默接受 `released = null`，
  // 因为 `=` 比 `\/` 优先，写下的根本不是赋值）。警告必须留在输出里。
  const args = ['-XX:+UseParallelGC', '-cp', JAR, 'tlc2.TLC', '-cleanup',
    '-metadir', metadir, '-config', join(MODEL_DIR, scenario.cfg), tla];
  const r = spawnSync('java', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rmSync(metadir, { recursive: true, force: true });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const parsed = parseTlc(out);
  return { ...parsed, exit_code: r.status, output_tail: out.split('\n').slice(-8).join('\n') };
}

/** cfg 里声明的 Shape —— 从**实际跑的配置文件**读，不从场景 id 猜。 */
function shapeOf(cfgRel) {
  try {
    const m = readFileSync(join(MODEL_DIR, cfgRel), 'utf8').match(/^\s*Shape\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * SCOPE 里声明过的 shape 必须**真跑过**。
 *
 * 「有界通过」这句话只有在说清它跑的是哪几张图时才成立：声明三个形状、实际只跑一张，
 * 剩下两张就是拿“已通过”替真实验收（专家 rc.15 复审 §6 的覆盖债务）。
 * 覆盖不足时不报错，而是把该模型的判定降为 `MODEL_INCONCLUSIVE` —— 沉默的“绿”比红更贵。
 */
function checkScopeCoverage(scenarios) {
  const report = {};
  for (const [model, scope] of Object.entries(SCOPE)) {
    if (!Array.isArray(scope.shapes)) continue;
    const refs = scenarios.filter((s) => s.model === model && s.kind === 'reference');
    const ran = [...new Set(refs
      .filter((s) => s.status === 'MODEL_PASS_BOUNDED' && (s.distinct_states ?? 0) > 0)
      .map((s) => s.shape).filter(Boolean))];
    report[model] = {
      declared: scope.shapes, ran,
      missing: scope.shapes.filter((x) => !ran.includes(x)),
      ok: scope.shapes.every((x) => ran.includes(x)),
    };
  }
  return report;
}

/** 模型动作表与 `Next` 的分岔集必须一一对应；不对应就是两份不同的模型。 */
function modelActions(tlaText) {
  // 三种定义写法都要认：`Enter(p) ==`、`MintRegister(i, d) ==`、`Quiesce == <单行函数体>`。
  // 参数只认单个字母时，Ownership 的多参动作（MintRegister/OverrideWithHandle）会被漏掉，
  // 于是"映射表缺行"这条判据对它们**静默失效** —— 那正是一个会假绿的地方。
  const defined = new Set([...tlaText.matchAll(/^([A-Za-z][A-Za-z0-9_]*)(?:\([a-z][A-Za-z0-9_, ]*\))? ==/gm)].map((m) => m[1]));
  const start = tlaText.indexOf('Next ==');
  const end = tlaText.indexOf('Spec ==');
  const block = start === -1 || end === -1 ? '' : tlaText.slice(start, end);
  const used = new Set([...block.matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]));
  // `Claimants` 与 `Instances` 同类：是**取值集合**而不是动作，不进映射表。
  return [...used].filter((n) => defined.has(n) && n !== 'Next' && n !== 'Actors'
    && n !== 'Plugins' && n !== 'Waiters' && n !== 'Instances' && n !== 'Handles'
    && n !== 'Claimants').sort();
}

function checkMapping(lifecycleText, ownershipText, hostText, dependencyText, serviceRegText) {
  const csv = readFileSync(join(HERE, 'adapter', 'mapping.csv'), 'utf8').trim().split('\n');
  const header = csv[0].split(',');
  const iAction = header.indexOf('model_action');
  const iStatus = header.indexOf('status');
  const iModel = header.indexOf('model');
  const rows = csv.slice(1).map((line) => line.split(','));
  const mapped = rows.map((r) => r[iAction]);
  // 每份模型的动作表必须**各自**齐：合成一张表时，Ownership 的动作会被
  // Lifecycle 的行"顺带满足"，缺行就看不出来。
  const MODELS = ['Lifecycle', 'Ownership', 'HostControl', 'Dependency', 'ServiceRegistration'];
  const textOf = { Lifecycle: lifecycleText, Ownership: ownershipText, HostControl: hostText, Dependency: dependencyText, ServiceRegistration: serviceRegText };
  const wantOf = (m) => (m === 'Lifecycle' ? modelActions(lifecycleText) : modelActions(textOf[m], true));
  const expect = MODELS.flatMap((m) => wantOf(m));
  const byModel = {};
  for (const m of MODELS) {
    const acts = rows.filter((r) => r[iModel] === m).map((r) => r[iAction]);
    const want = wantOf(m);
    byModel[m] = { missing: want.filter((a) => !acts.includes(a)), extra: acts.filter((a) => !want.includes(a)) };
  }
  return {
    header_ok: iAction !== -1 && iStatus !== -1 && iModel !== -1,
    model_actions: expect,
    mapped_actions: mapped,
    missing: expect.filter((a) => !mapped.includes(a)),
    extra: mapped.filter((a) => !expect.includes(a)),
    by_model: byModel,
    statuses: rows.reduce((acc, r) => { acc[r[iStatus]] = (acc[r[iStatus]] ?? 0) + 1; return acc; }, {}),
  };
}

function toolchain() {
  const java = spawnSync('java', ['-version'], { encoding: 'utf8' });
  const javaVersion = `${java.stderr ?? ''}${java.stdout ?? ''}`.split('\n')[0]?.trim() || null;
  const javaOk = java.status === 0;
  const jarPresent = existsSync(JAR);
  let pinOk = null; let jarSha = null; let pinExpected = null;
  if (existsSync(PIN_FILE)) {
    const m = readFileSync(PIN_FILE, 'utf8').match(/^([0-9a-f]{64})\s+/m);
    pinExpected = m ? m[1] : null;
  }
  if (jarPresent) { jarSha = sha256(readFileSync(JAR)); pinOk = pinExpected == null ? false : jarSha === pinExpected; }
  return { java: javaVersion, java_ok: javaOk, jar_path: rel(JAR), jar_present: jarPresent, jar_sha256: jarSha, jar_pin: pinExpected, jar_pin_ok: pinOk };
}

/**
 * 先把上一轮的证据**作废**，再开始跑。
 *
 * 这一条是补出来的，因为本仓真的踩过：S7 把插件名判据收紧之后，实现轨的夹具还在用
 * `'A'` 当插件名，于是 `run-formal.mjs` 在**第一条重放之前**就崩了 —— 而磁盘上留着
 * 上一轮的 `IMPLEMENTATION_PASS`，谁看都是一片绿。一个崩溃被当成了证据。
 *
 * 现在先删报告、再落一个 `RUNNING` 哨兵：中途死掉留下的不是旧结论，
 * 而是一个明说自己没跑完的文件。只有走到底才会被真实结论覆盖。
 */
function invalidateReports(reason) {
  for (const f of ['model-check.json', 'implementation.json']) {
    const p = join(REPORTS, f);
    if (existsSync(p)) unlinkSync(p);
  }
  const stamp = { generated_by: 'verification/run-formal.mjs', generated_at: new Date().toISOString(),
    status: 'NOT_RUN', reason, note: '本次运行没有跑完（或刚开始）。这是哨兵，不是结论；不得引用为证据。' };
  writeFileSync(join(HERE, 'counterexamples', 'index.jsonl'), '');
  return stamp;
}

async function main() {
  mkdirSync(REPORTS, { recursive: true });
  mkdirSync(join(HERE, 'counterexamples'), { recursive: true });
  invalidateReports('run_started');
  const modelText = readFileSync(TLA, 'utf8');
  const ownershipText = readFileSync(OWNERSHIP, 'utf8');
  const hostText = readFileSync(HOSTCONTROL, 'utf8');
  const dependencyText = readFileSync(DEPENDENCY, 'utf8');
  const serviceRegText = readFileSync(SERVICEREG, 'utf8');
  const mapping = checkMapping(modelText, ownershipText, hostText, dependencyText, serviceRegText);
  const tc = toolchain();
  const blocked = !tc.java_ok ? 'java_not_found' : !tc.jar_present ? 'tla2tools_jar_missing' : tc.jar_pin_ok === false ? 'jar_sha256_mismatch' : null;

  const scenarios = [];
  for (const s of SCENARIOS) {
    const base = { model: s.model, id: s.id, kind: s.kind, config: rel(join(MODEL_DIR, s.cfg)), contract: s.contract ?? null, deviation: s.deviation ?? null, refers_to: s.refers_to ?? null, shape: s.model === 'Dependency' ? shapeOf(s.cfg) : null };
    if (blocked) {
      scenarios.push({ ...base, status: 'NOT_RUN', reason: blocked });
      continue;
    }
    const r = runTlc(s);
    const cfgSha = sha256(readFileSync(join(MODEL_DIR, s.cfg)));
    const entry = { ...base, config_sha256: cfgSha, states_generated: r.states_generated, distinct_states: r.distinct_states, depth: r.depth, observed_property: r.property, trace: r.trace, tlc_version: r.tlc_version, exit_code: r.exit_code };
    if (s.kind === 'reference') {
      entry.status = r.pass ? 'MODEL_PASS_BOUNDED' : 'MODEL_COUNTEREXAMPLE';
      entry.stop_fault = s.stopFault;
    } else if (r.pass) {
      entry.status = 'MODEL_INCONCLUSIVE';
      entry.sensitivity = 'SURVIVED';
      entry.note = '突变体没被杀死：模型对该偏差不敏感，不得计作通过';
    } else {
      entry.status = 'MODEL_COUNTEREXAMPLE';
      entry.sensitivity = 'KILLED';
      entry.expected_property = s.expect;
      entry.property_matched = r.property === s.expect;
    }
    if (!r.pass && !r.property) entry.output_tail = r.output_tail;
    scenarios.push(entry);
  }

  const refs = scenarios.filter((s) => s.kind === 'reference');
  const mutants = scenarios.filter((s) => s.kind === 'mutant');
  const coverage = checkScopeCoverage(scenarios);
  const killed = mutants.filter((s) => s.sensitivity === 'KILLED').length;
  const survived = mutants.filter((s) => s.sensitivity === 'SURVIVED').length;
  const propertyMatched = mutants.filter((s) => s.sensitivity === 'KILLED' && s.property_matched).length;

  // 每个模型各自判定。**不能**合并成一个总分：Lifecycle 全绿不代表 Ownership 有模型，
  // 反过来也是。合起来算一个绿灯，就是把"两份模型的覆盖"混成一句空话。
  const perModel = {};
  for (const name of ['Lifecycle', 'Ownership', 'HostControl', 'Dependency', 'ServiceRegistration']) {
    const mRefs = refs.filter((r) => r.model === name);
    const mMutants = mutants.filter((r) => r.model === name);
    const mKilled = mMutants.filter((r) => r.sensitivity === 'KILLED').length;
    const mSurvived = mMutants.filter((r) => r.sensitivity === 'SURVIVED').length;
    const mMatched = mMutants.filter((r) => r.sensitivity === 'KILLED' && r.property_matched).length;
    const covered = SCENARIOS.some((x) => x.model === name);
    if (blocked || !covered) {
      perModel[name] = { status: 'NOT_RUN', reason: blocked ?? 'no_scenario', refs: mRefs.length, mutants: mMutants.length, killed: mKilled, survived: mSurvived };
      continue;
    }
    const refsOk = mRefs.length > 0 && mRefs.every((r) => r.status === 'MODEL_PASS_BOUNDED');
    perModel[name] = {
      status: refsOk && mSurvived === 0 && mMatched === mKilled ? 'MODEL_PASS_BOUNDED' : 'MODEL_INCONCLUSIVE',
      refs: mRefs.length, mutants: mMutants.length, killed: mKilled, survived: mSurvived,
      property_matched: mMatched,
    };
    // 声明了但没跑的 shape ⇒ 这份模型不能报“有界通过”。
    const cov = coverage[name];
    if (cov && !cov.ok) {
      perModel[name].status = 'MODEL_INCONCLUSIVE';
      perModel[name].missing_shapes = cov.missing;
    }
  }
  // 总状态取**最差**的一份：有模型没建，就不能报整体 PASS。
  const statusRank = ['NOT_RUN', 'MODEL_INCONCLUSIVE', 'MODEL_COUNTEREXAMPLE', 'MODEL_PASS_BOUNDED'];
  const modelStatus = ['Lifecycle', 'Ownership', 'HostControl', 'Dependency', 'ServiceRegistration']
    .map((n) => perModel[n].status)
    .reduce((a, b) => (statusRank.indexOf(a) <= statusRank.indexOf(b) ? a : b));

  const modelTexts = { Lifecycle: modelText, Ownership: ownershipText, HostControl: hostText, Dependency: dependencyText, ServiceRegistration: serviceRegText };
  // 清单必须与 per_model 同步：两者不一致时**当场失败**，而不是写进报告等人发现。
  if (Object.keys(perModel).length !== MODEL_FILES.length) {
    throw new Error(`模型清单不一致：per_model 有 ${Object.keys(perModel).length} 份，登记表有 ${MODEL_FILES.length} 份`);
  }
  const provenance = sourceProvenance(REPO_ROOT);
  const modelReport = {
    generated_by: 'verification/run-formal.mjs',
    generated_at: new Date().toISOString(),
    status: modelStatus,
    // 出处：这份报告描述的是**哪棵树**。缺了它，报告过期与否无人可知（见 lib/provenance.mjs）。
    source: provenance,
    models: MODEL_FILES.map((m) => ({
      name: m.name, file: rel(m.file), sha256: sha256(modelTexts[m.name]), contracts: m.contracts,
    })),
    // 兼容旧消费者：`model` 仍指向 Lifecycle，但**判定以 models + per_model 为准**。
    model: { file: rel(TLA), sha256: sha256(modelText), contracts: ['F03', 'F04', 'F05', 'F08'] },
    per_model: perModel,
    scope: SCOPE,
    // 每个模型“声明的 shape”×“真的跑过的 shape”。不等就是覆盖不足，判定已降级。
    scope_coverage: coverage,
    toolchain: tc,
    blocked_reason: blocked,
    scenarios,
    sensitivity: { mutants: mutants.length, killed, survived, property_matched: propertyMatched, ok: killed > 0 && survived === 0 && propertyMatched === killed },
    // 自审记录：模型自己也要被杀死一次。第一版真的没杀死 m3。
    sensitivity_audit: [
      {
        revision: 'Ownership@first-draft',
        observed: '参考模型自己违反 `<>released`；六个突变体里 m10/m11 存活',
        diagnosis: '① 把"存在一条能成功的轨迹"写成了时态性质（Init 上 Quiesce 自环即可绕过）；'
          + '② 下界性质里写了 `IsM10 \/ …`，等于让突变体给自己开后门；'
          + '③ 改用"存在指向当前登记的句柄"仍不够 —— "一律拒绝"时句柄照样在，只是没人能用',
        fix: '下界性质改用 `ENABLED <动作>`：问的是"此刻还发不发得出来"，不是"有没有发生过"。'
          + 'm10 撞 INV_F01_RELEASE_ENABLED、m11 撞 INV_F01_REAP_ENABLED，参考模型 1138 状态无违例',
      },
      {
        revision: 'Ownership@draft-0',
        observed: 'TLC 静默接受 `released = null` 这个状态',
        diagnosis: "TLA+ 里 `=` 比 `\/` 优先，`x' = x \/ y` 被解析成 `(x' = x) \/ y`，根本不是赋值；"
          + '`-nowarning` 把这类语义警告一起吞了',
        fix: '所有赋值加括号；新增 INV_F01_GHOSTS_BOOLEAN 把"幽灵变量只能是布尔"变成可判定；'
          + 'runTlc 去掉 `-nowarning`',
      },
      {
        revision: '799c4d519ce0c6664ca5da87c17a098456e51105564a41d957247d7e13cd56d8',
        observed: 'm3-timeout-releases-lock 存活（no error），其它四个突变体均已杀死',
        diagnosis: 'Enter 前置条件里人为写了 attempt = "idle"，把并发进入串行化了 —— 真实 runExclusive 不读 attempt，只读队列 Map',
        fix: '删掉 Enter / EnterFromQueue 上该前置条件；m3 随后撞 INV_F04_MUTEX（47 个不同状态，深度 4）',
      },
      {
        revision: 'Dependency@first-draft',
        observed: '参考模型自己在 StopOk("a") 上违反 INV_F06_NO_PREMATURE_RELEASE（b 还 running，a 已 released）',
        diagnosis: '把「p 在环里」当成了「p 的所有依赖方都可以不管」，于是环外依赖方 b→a 被连带豁免。'
          + '另一次：把环的豁免挂到 reportedCycles 上，于是「环没报」变成前置条件，m18 根本碰不到违规 —— 突变体存活',
        fix: '豁免只看图（p 与 q 同在 Cyclic 才算环内边）；且 truth 与 guard 必须分成两个算子 —— '
          + 'TruthReady 不含突变体谓词（定义什么叫违规），Ready 含（定义允不允许发）。'
          + '合成一个时幽灵判据会跟着守卫一起被放宽',
      },
      {
        revision: 'Dependency@m16-m18-alive',
        observed: 'm16-insertion-as-topology 与 m18-swallow-cycle 存活（no error），其余三个被杀死',
        diagnosis: '① m16 挂在 "chain" 形状下跑，而那条图本来就有活边，faithful 本来就是 dependency —— '
          + '突变体没有触发点。不是模型太弱，是变体配置写错了；'
          + '② m18 的偏差被「环必须先报」那个前置条件顶住，根本走不到',
        fix: 'm16 改用 Shape="no-live"（只有一条指向缺席提供者的边，faithful 必为 insertion）；'
          + 'm18 的豁免从前置条件改为纯图判据。两者随后各撞 INV_F06_BASIS_FAITHFUL / '
          + 'INV_F06_NO_SILENT_CYCLE 被杀死，参考模型两个 shape 仍无违例',
      },
      {
        revision: 'Dependency@rc15-single-cycle',
        observed: '专家 R15-01 的跨 SCC 反例在实现上能复现，而模型的 chain 形状报 MODEL_PASS_BOUNDED —— '
          + '两种说法看起来矛盾，实际是覆盖债务：单环图下“同一个 SCC”与“出现在任意一个环里”给出完全相同的结果',
        diagnosis: '把 m21（跨 SCC 错误豁免）放到旧的 chain 形状下跑，它**存活**（49 states generated / 20 distinct，no error）—— '
          + '不是模型太弱，是图上根本没有第二个环，“环间那条边”不存在',
        fix: '新增 Shape=two-cycles-linked（a↔b + c↔d + c→a）与 m21；m21 在 5 个不同状态、深度 7 上撞 '
          + 'INV_F06_NO_PREMATURE_RELEASE。同时把“声明过的 shape 必须真跑过”写进 scope_coverage：'
          + '声明的 shape 没跑时，该模型自动降为 MODEL_INCONCLUSIVE',
      },
    ],
    not_modelled: [
      {
        contract: 'F02',
        reason: '本轮不建（**不是**「永久不适合建模」）：F02 的主要风险是**真实入口清单不完备**，'
          + '而模型只能把手写的清单喂给 TLC —— 清单漏一个入口，模型照样报 MODEL_PASS_BOUNDED，'
          + '那是假保证。本轮证据改为实现层：单一入口清单 + 逐入口准入负例 + sandbox on/off 变形测试',
        trigger: '一旦出现**跳多个异步执行阶段的入口准入交错**（两个入口在不同微任务阶段各自'
          + '通过准入、合并后却构成一次未授权调用），就把那段有限状态入模，不扩整套 TLA+',
        coverage_gap: '入口清单目前**未集中定义**：`IMPLEMENTATION_PASS` 只覆盖已列出的入口，'
          + '不等于「全入口完备」已获证实',
      },
      {
        contract: 'F07',
        reason: '本轮不建（**不是**「永久不适合建模」）：事件投递时刻没有可穷举的交错'
          + '（`postCheck` 在 resolve 之后才调，一条直线），真正有内容的是一张纯函数决策表；'
          + '搬进 TLA+ 等于把 `_failureFromThrown` 的判据表再抄一遍。'
          + '本轮证据：结果决策表 + 变异测试 + 故障注入（后置观察者抛错不得反向改写事实）',
        trigger: '一旦后置观察被移到**可与提交交错**的位置（提交前就发出、或与另一个写者并行），'
          + '就补一个只含该交错的最小模型',
      },
      { contract: 'F01-service', reason: 'Ownership.tla 只建模能力侧登记；服务侧 registerService/@host 接管未入模（见 F05 服务侧计数例）' },
      { contract: 'F01-handle-secrecy', reason: '句柄保密性未入模：模型假设句柄不可枚举，真实实现靠 WeakMap 私有绑定' },
    ],
    mapping_check: mapping,
    limitations: [
      '有界：只穷举 SCOPE 里的维度。N 个插件、任意 epoch 上界下的同一性质未被证明',
      'ModelPass 不是「实现安全」：它只说「在这个模型和这些不变量下没找到反例」',
      'TLC 没跑（NOT_RUN）时，任何「已形式化验证」的说法都不成立',
    ],
  };
  writeFileSync(join(REPORTS, 'model-check.json'), `${JSON.stringify(modelReport, null, 2)}\n`);

  // ── 实现轨 ─────────────────────────────────────────────────────
  let implRecords = [];
  let implError = null;
  try {
    const { Core } = await import(join(REPO, 'src/core/core.js'));
    const { LifecycleManager } = await import(join(REPO, 'src/core/lifecycle-manager.js'));
    implRecords = await runReplay({ Core, LifecycleManager });
  } catch (err) {
    implError = String(err?.stack ?? err).slice(0, 1200);
  }
  const implPass = implRecords.filter((r) => r.status === 'IMPLEMENTATION_PASS').length;
  const implFail = implRecords.filter((r) => r.status === 'IMPLEMENTATION_COUNTEREXAMPLE').length;
  const implReport = {
    generated_by: 'verification/run-formal.mjs',
    generated_at: new Date().toISOString(),
    // 与模型轨同一份出处：两份报告必须描述同一棵树，否则「模型过了、实现没过」这种
    // 结论可能只是拿两个版本的证据拼出来的。
    source: provenance,
    status: implError ? 'NOT_RUN' : implFail === 0 ? 'IMPLEMENTATION_PASS' : 'IMPLEMENTATION_COUNTEREXAMPLE',
    error: implError,
    totals: { records: implRecords.length, pass: implPass, counterexample: implFail },
    records: implRecords,
    limitations: [
      '这是真实 src/ 的重放，不是模型；但它验证的是**这几条**轨迹，不是全空间',
      'F05 的 epoch 落点是直接写 Core._epoch += 1（与 Core.stop 同一原子点），不是走完整 stop()',
    ],
  };
  writeFileSync(join(REPORTS, 'implementation.json'), `${JSON.stringify(implReport, null, 2)}\n`);

  // ── 反例索引：模型变体与真实重放必须分得开 ──────────────────────
  const lines = [];
  for (const s of mutants.filter((m) => m.status === 'MODEL_COUNTEREXAMPLE')) {
    lines.push({
      id: s.id, kind: 'mutant', source: 'model', contract: s.contract, refers_to: s.refers_to,
      deviation: s.deviation, violated: s.observed_property, trace: s.trace,
      distinct_states: s.distinct_states, depth: s.depth, config_sha256: s.config_sha256,
      model_sha256: modelReport.model.sha256,
    });
  }
  for (const r of implRecords.filter((x) => x.status === 'IMPLEMENTATION_COUNTEREXAMPLE')) {
    lines.push({
      id: r.seed, kind: 'implementation', source: 'replay', contract: r.contract,
      implementation: r.implementation, actions: r.actions, observed: r.observed, baseline: r.baseline,
    });
  }
  writeFileSync(join(HERE, 'counterexamples', 'index.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));

  // 写完之后自己再读一遍：报告是给审查者看的，不得手改，也不得与它的输入不一致。
  const violations = assertArtifacts({ modelReport, implReport, lines });

  // ── 小结 ───────────────────────────────────────────────────────
  console.log(`[model] ${modelStatus}  tlc=${tc.jar_sha256 ? tc.jar_sha256.slice(0, 12) : 'n/a'}  java=${tc.java ?? 'n/a'}`);
  for (const s of scenarios) {
    const extra = s.sensitivity ? ` (${s.sensitivity}${s.property_matched === false ? ', property mismatch' : ''})` : '';
    console.log(`  ${String(s.id).padEnd(34)} ${String(s.status).padEnd(26)}${s.observed_property ? ` ${s.observed_property}` : ''}${extra}`);
  }
  console.log(`[impl]  ${implReport.status}  ${implPass}/${implRecords.length} pass, ${implFail} counterexample`);
  if (!mapping.header_ok) console.log('[mapping] 表头不对：需要 model / model_action / status 三列');
  for (const [m, r] of Object.entries(mapping.by_model)) {
    if (r.missing.length) console.log(`[mapping] ${m} 缺行：${r.missing.join(', ')}`);
    if (r.extra.length) console.log(`[mapping] ${m} 多余：${r.extra.join(', ')}`);
  }
  for (const v of violations) console.log(`[artifacts] 不一致：${v}`);
  console.log(`[artifacts] reports/model-check.json, reports/implementation.json, counterexamples/index.jsonl`);

  if (blocked) {
    console.log(`[blocked] ${blocked} —— 全轨 NOT_RUN（合同 §7：缺工具不得写 PASS）`);
    return STRICT ? 2 : 0;
  }
  const bad = survived > 0 || refs.some((r) => r.status !== 'MODEL_PASS_BOUNDED')
    || propertyMatched !== killed || implFail > 0 || implError !== null || !mapping.header_ok
    || Object.values(mapping.by_model).some((r) => r.missing.length > 0 || r.extra.length > 0)
    || violations.length > 0;
  return bad ? 1 : 0;
}

const VOCAB = new Set(['MODEL_PASS_BOUNDED', 'MODEL_COUNTEREXAMPLE', 'MODEL_INCONCLUSIVE',
  'IMPLEMENTATION_PASS', 'IMPLEMENTATION_COUNTEREXAMPLE', 'NOT_RUN', 'NOT_MAPPED']);

/**
 * 落盘后的自检：状态词只能出那七个，警句不能自己长出来，计数不能和明细对不上。
 * 一个能被手改而不报警的报告，审的人就只能靠信任 —— 那是没用的证据。
 */
function assertArtifacts({ modelReport, implReport, lines }) {
  const out = [];
  const raw = [
    readFileSync(join(REPORTS, 'model-check.json'), 'utf8'),
    readFileSync(join(REPORTS, 'implementation.json'), 'utf8'),
  ];
  for (const text of raw) {
    // 「已验证」是禁用词：不加对象与范围就不许用。
    if (/\bVERIFIED\b/.test(text)) out.push('报告里出现裸 VERIFIED');
  }
  for (const s of modelReport.scenarios) {
    if (!VOCAB.has(s.status)) out.push(`场景 ${s.id} 的状态词不在词汇表：${s.status}`);
  }
  for (const r of implReport.records) {
    if (!VOCAB.has(r.status)) out.push(`重放 ${r.contract} 的状态词不在词汇表：${r.status}`);
  }
  const killedMutants = modelReport.scenarios.filter((s) => s.kind === 'mutant' && s.sensitivity === 'KILLED').length;
  const mutantLines = lines.filter((l) => l.kind === 'mutant').length;
  if (killedMutants !== mutantLines) out.push(`反例索引里模型变体 ${mutantLines} 条，但已杀死 ${killedMutants} 个`);
  const implLines = lines.filter((l) => l.kind === 'implementation').length;
  const implFails = implReport.records.filter((r) => r.status === 'IMPLEMENTATION_COUNTEREXAMPLE').length;
  if (implFails !== implLines) out.push(`反例索引里真实重放 ${implLines} 条，但失败记录 ${implFails} 条`);
  if (modelReport.status === 'MODEL_PASS_BOUNDED' && modelReport.sensitivity.survived > 0) {
    out.push('有突变体存活却写了 MODEL_PASS_BOUNDED');
  }
  return out;
}

let exitCode;
try {
  exitCode = await main();
} catch (err) {
  // 掉在这条路径上（含未捕获的拒约）时，磁盘上必须**没有**可被当成结论的报告。
  invalidateReports(`crashed: ${String(err?.message ?? err).slice(0, 300)}`);
  writeFileSync(join(REPORTS, 'model-check.json'), `${JSON.stringify({
    generated_by: 'verification/run-formal.mjs',
    generated_at: new Date().toISOString(),
    status: 'NOT_RUN',
    error: String(err?.stack ?? err).slice(0, 2000),
    note: '运行崩溃。旧结论已作废；不得引用本文件为证据。',
  }, null, 2)}\n`);
  console.error(`[crash] ${String(err?.message ?? err)}`);
  exitCode = 1;
}
process.exitCode = exitCode;
