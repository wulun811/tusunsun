import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
// 子进程归属与回收：harness 在文件桶边界调用 reapAll()。
import { reapAll, spawnManaged } from './lib/proc.mjs';
import { rejectNodeTestContext } from './lib/node-test-guard.mjs';

// node --test 不调用 setup()：任何 harness 用例被它单文件加载都会把 0 断言记成通过。
// import 期直接拒绝，让错误在第一个文件出现时就可见。
rejectNodeTestContext('test/harness.mjs');

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';

export class TestRunner {
  constructor(options = {}) {
    this.name = options.name || 'Test Suite';
    this.tests = [];
    // R0-70（性能修复）：钩子必须**按文件分桶**。
    //
    // 修复前的真实缺陷：所有文件注册的钩子被存进**扁平数组**，而 run() 在**每个用例**
    // 前后都执行全部钩子 → 30 个 beforeEach + 28 个 afterEach 会被执行
    // 971 × 58 ≈ 56,000 次（正确语义下仅需数百次）。这些钩子含 mkdirSync/rmSync/new Core
    // 等文件系统操作，是本套件最大的时间浪费；更严重的是造成**跨文件污染**：
    // 某文件 beforeEach 里劫持的 process.stderr.write、process.chdir() 会作用到其它文件的用例。
    //
    // 现改为：钩子归属注册它的文件，只作用于该文件的用例。
    this.hookBuckets = new Map();   // file → { beforeAll, afterAll, beforeEach, afterEach }
    this.setCurrentFile(null);
    this.results = { passed: 0, failed: 0, skipped: 0, total: 0 };
    // R0-75（专家 P0-2 追加）：钩子抛错此前**只打印不计数**——afterAll 抛错时套件仍绿、退出码仍 0，
    // 清理失败对 CI 不可见。现计入 hookErrors 并使其非零退出（与用例失败同等可见）。
    this.hookErrors = 0;
    // R0-75：文件边界全局状态（cwd / process.stderr.write）的**harness 级复原**计数（证据用）。
    this.globalRestores = { chdir: 0, stderrWrite: 0 };
    this._skipNote = null;   // R0-75：运行期显式跳过标记（由 noteSkip() 设置）
    this.startTime = null;
    this.endTime = null;
    this.reporters = options.reporters || ['console'];
    this.reportData = [];
  }

  beforeAll(fn) { this._bucket().beforeAll.push(fn); }
  afterAll(fn) { this._bucket().afterAll.push(fn); }
  beforeEach(fn) { this._bucket().beforeEach.push(fn); }
  afterEach(fn) { this._bucket().afterEach.push(fn); }

  // 性能分析（R0-70）：记录用例所属**文件**，以便按文件聚合耗时、定位热点。
  setCurrentFile(file) { this._currentFile = file || '(default)'; }

  _bucket() {
    const key = this._currentFile || '(default)';
    if (!this.hookBuckets.has(key)) {
      this.hookBuckets.set(key, { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] });
    }
    return this.hookBuckets.get(key);
  }

  test(name, fn, options = {}) {
    this.tests.push({
      name, fn, options, status: 'pending',
      file: options.file || this._currentFile || null,
      bucket: this._bucket(),
    });
  }

  /**
   * R0-75（B 包发现）：**运行期显式跳过**。
   *
   * 真实缺陷：`dist/oss` 未构建时，产物类用例的写法是
   * `console.log('[NOT_RUN] ...'); return;` —— 用例体正常返回，harness 记 **PASS**。
   * 于是"产物真的被验收过"与"产物根本没构建"在报告与退出码上**完全无法区分**
   * （与专家反复点名的"静默跳过 = 覆盖率假象"同类）。
   *
   * 现提供 `runner.noteSkip(理由)`：用例体内调用后，本用例记为 **skipped**（报告里
   * `status:'skip'` 且带理由），不会污染 passed 计数；有网络/构建等前置时用它，
   * 不要用"打印一行然后正常返回"。
   */
  noteSkip(reason) {
    // R0-77（专家 B 节）：**必验收模式**下"显式跳过"也不是通行证——产物缺失/前置缺失必须硬红。
    // 由发布档门禁以 TT_REQUIRE_PRECONDITIONS=1 打开；开发态保持可跳过但记为 SKIP（报告可见）。
    if (process.env.TT_REQUIRE_PRECONDITIONS === '1') {
      throw new Error(`[REQUIRED] 必验收模式下不得跳过：${reason || 'skipped'}`);
    }
    this._skipNote = reason || 'skipped';
  }

  skip(name, fn, options = {}) {
    this.tests.push({ name, fn, options, status: 'skipped', bucket: this._bucket() });
    this.results.skipped++;
  }

  async run() {
    this.startTime = Date.now();
    this._printHeader();

    // R0-70：钩子按文件桶执行（beforeAll 在该文件首个用例前跑一次，afterAll 在离开该文件时跑一次）
    let currentBucket = null;
    let bucketGlobals = null;   // R0-75：进入本文件桶时的全局状态快照
    let hookSelfMs = 0;
    // R0-115：**文件桶边界回收本文件留下的子进程**。
    //
    // 事故：一次 `npm test` 之后残留大量外接引擎 Python 进程（数 GB 内存）+
    // 76 个 dsec scope，把 16G 内存吃光。根因是"每个会起网关的用例各自管自己的清理"，
    // 只要有一个用例提前 throw / 忘了 stop，孤儿就永久留下——**靠自觉必然漏**。
    // 现在由 harness 在该文件桶结束时统一回收（见 test/lib/proc.mjs），
    // 用例自己清理仍是第一道；这是第二道，且不依赖用例是否记得。
    const reapBucketProcs = async (bucket) => {
      try {
        const leaked = await reapAll();
        if (leaked.length > 0) {
          this.hookErrors++;
          const names = leaked.map((r) => `${r.pid}(${r.label})`).join(', ');
          this._printError('reap', new Error(`文件结束时仍有子进程无法回收（孤儿风险）：${names}`));
        }
      } catch (e) {
        this.hookErrors++;
        this._printError('reap', e);
      }
    };
    const runAfterAll = async (bucket) => {
      for (const hook of bucket.afterAll) {
        try { await hook(); } catch (e) { this.hookErrors++; this._printError('afterAll', e); }
      }
      await reapBucketProcs(bucket);
    };
    // R0-75：**文件边界全局状态复原由 harness 自己保证**。
    // 专家原话：「process.chdir/stderr.write 等是否由 harness 或 fixture 真实恢复
    //（不能把测试自己复位当作 harness 保证）」。修复前实测：某文件在 beforeEach 里
    // chdir + 劫持 stderr.write 且**自己不复位**时，下一个文件会看到被污染的状态。
    // 现在由 harness 在该文件桶结束时无条件复原（同一文件内部仍保持原语义，不受影响）。
    // 覆盖边界：仅 cwd 与 process.stderr.write；process.env / 其它全局不在此保证内（另有测试固化）。
    const snapshotGlobals = () => ({ cwd: process.cwd(), stderrWrite: process.stderr.write });
    const restoreGlobals = (snap) => {
      if (!snap) return;
      try {
        if (process.cwd() !== snap.cwd) { process.chdir(snap.cwd); this.globalRestores.chdir++; }
      } catch { /* 复原尽力而为，不因复原失败吞掉原用例结论 */ }
      if (process.stderr.write !== snap.stderrWrite) {
        process.stderr.write = snap.stderrWrite;
        this.globalRestores.stderrWrite++;
      }
    };

    for (const t of this.tests) {
      this.results.total++;
      if (t.status === 'skipped') {
        this._printSkip(t.name);
        continue;
      }

      if (t.bucket !== currentBucket) {
        if (currentBucket) { await runAfterAll(currentBucket); restoreGlobals(bucketGlobals); }
        currentBucket = t.bucket;
        bucketGlobals = snapshotGlobals();
        for (const hook of currentBucket.beforeAll) {
          try { await hook(); } catch (e) { this._printError('beforeAll', e); process.exit(1); }
        }
      }

      const h0 = Date.now();
      for (const hook of currentBucket.beforeEach) {
        try { await hook(); } catch (e) { this.hookErrors++; this._printError('beforeEach', e); }
      }
      hookSelfMs += Date.now() - h0;

      // R0-70：**真实计时**（此前 duration 恒为 0，报告无法用于性能分析）
      const t0 = Date.now();
      try {
        this._skipNote = null;
        await t.fn();
        if (this._skipNote) {
          // R0-75：运行期显式跳过（前置缺失/无网络），**必须**与"真跑通过"区分
          t.status = 'skipped';
          this.results.skipped++;
          this._printSkip(`${t.name} — ${this._skipNote}`);
          this.reportData.push({ name: t.name, status: 'skip', duration: Date.now() - t0, file: t.file, error: this._skipNote });
        } else {
          t.status = 'passed';
          this.results.passed++;
          this._printPass(t.name);
          this.reportData.push({ name: t.name, status: 'pass', duration: Date.now() - t0, file: t.file });
        }
      } catch (e) {
        t.status = 'failed';
        this.results.failed++;
        this._printFail(t.name, e);
        this.reportData.push({ name: t.name, status: 'fail', error: e.message, duration: Date.now() - t0, file: t.file });
      }

      const a0 = Date.now();
      for (const hook of currentBucket.afterEach) {
        try { await hook(); } catch (e) { this.hookErrors++; this._printError('afterEach', e); }
      }
      hookSelfMs += Date.now() - a0;
    }
    if (currentBucket) { await runAfterAll(currentBucket); restoreGlobals(bucketGlobals); }

    this.endTime = Date.now();
    this.hookSelfMs = hookSelfMs;
    this._printSummary();
    this._writeReport();

    // R0-75：钩子抛错（含 afterAll 清理失败）与用例失败同等阻断——清理失败不得静默通过。
    if (this.results.failed > 0 || this.hookErrors > 0) process.exit(1);
  }

  _printHeader() {
    console.log(`\n${BOLD}=== ${this.name} ===${RESET}`);
  }

  _printPass(name) {
    console.log(`  ${GREEN}PASS${RESET} ${name}`);
  }

  _printFail(name, error) {
    console.log(`  ${RED}FAIL${RESET} ${name}`);
    console.log(`       ${RED}${error.message}${RESET}`);
  }

  _printSkip(name) {
    console.log(`  ${YELLOW}SKIP${RESET} ${name}`);
  }

  _printError(hook, error) {
    console.log(`  ${RED}ERROR${RESET} in ${hook}: ${error.message}`);
  }

  _printSummary() {
    const duration = ((this.endTime - this.startTime) / 1000).toFixed(2);
    console.log(`\n${BOLD}=== Summary ===${RESET}`);
    console.log(`  Total: ${this.results.total} | ${GREEN}Passed: ${this.results.passed}${RESET} | ${RED}Failed: ${this.results.failed}${RESET} | ${YELLOW}Skipped: ${this.results.skipped}${RESET}`);
    if (this.hookErrors > 0) console.log(`  ${RED}Hook errors: ${this.hookErrors}${RESET}（钩子/清理抛错，已计入阻断）`);
    // R2（专家 0.15.3 深审 §1.2 的教训）：SKIP 的原因必须写在**汇总行旁边**。
    // 同一份用例在能跑真实浏览器的机器上是 56/56，在导航被环境策略拦住的机器上是
    // 49 PASS / 7 SKIP —— 两个数字都是真的，错只错在“数字不自己解释自己”。
    // 现在按原因归并打印，读者不必去翻上面的逐条日志。
    if (this.results.skipped > 0) {
      const byReason = new Map();
      for (const r of this.reportData) {
        if (r.status !== 'skip') continue;
        const key = String(r.error || 'skipped');
        byReason.set(key, (byReason.get(key) || 0) + 1);
      }
      for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${YELLOW}SKIP ×${n}${RESET}: ${reason}`);
      }
    }
    console.log(`  Duration: ${duration}s`);
  }

  _writeReport() {
    // R0-70：协调器（run-unit.mjs）用 TT_REPORT 指定每文件的报告落点以便聚合；
    // 单独运行时仍写默认路径，保持既有行为。
    const reportPath = process.env.TT_REPORT
      || join(projectRoot, 'test-results', `${this.name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.json`);
    if (!existsSync(join(projectRoot, 'test-results'))) {
      mkdirSync(join(projectRoot, 'test-results'), { recursive: true });
    }

    // Sanitize reportData: ensure error messages are plain strings
    const sanitizedTests = this.reportData.map(t => {
      const entry = { name: t.name, status: t.status, duration: t.duration || 0 };
      if (t.file) entry.file = t.file;
      if (t.error != null) {
        entry.error = String(t.error).slice(0, 500);
      }
      return entry;
    });

    // R0-70：按文件聚合耗时（性能分析用；不影响断言语义）
    const byFile = {};
    for (const t of this.reportData) {
      const k = (t.file || '').replace(projectRoot + '/', '') || '(unknown)';
      byFile[k] = (byFile[k] || 0) + (t.duration || 0);
    }
    const slowestFiles = Object.entries(byFile)
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([file, ms]) => ({ file, ms }));
    const selfMs = this.reportData.reduce((s, t) => s + (t.duration || 0), 0);

    const report = {
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.endTime - this.startTime,
      selfDuration: selfMs,          // 用例自身耗时合计
      hookDuration: this.hookSelfMs || 0,   // 钩子（beforeEach/afterEach）耗时合计
      overhead: (this.endTime - this.startTime) - selfMs - (this.hookSelfMs || 0),
      slowestFiles,                  // Top 20 热点文件
      results: this.results,
      hookErrors: this.hookErrors || 0,          // R0-75：钩子/清理抛错（非零即阻断）
      globalRestores: this.globalRestores,       // R0-75：harness 在文件边界实际复原的次数（证据）
      tests: sanitizedTests,
    };

    try {
      const seen = new Set();
      const safeJson = JSON.stringify(report, (key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (typeof value === 'symbol') return value.toString();
        if (typeof value === 'function') return '[Function]';
        if (typeof value === 'undefined') return null;
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
        return value;
      }, 2);
      writeFileSync(reportPath, safeJson);
    } catch {
      // If serialization still fails, write minimal report
      const fallback = {
        name: this.name,
        results: this.results,
        tests: this.reportData.map(t => ({ name: t.name, status: t.status })),
      };
      try {
        writeFileSync(reportPath, JSON.stringify(fallback, null, 2));
      } catch {
        // Last resort: write plain text
        writeFileSync(reportPath.replace(/\.json$/, '.txt'), `${this.name}: ${this.results.passed} passed, ${this.results.failed} failed`);
      }
    }
  }
}

export class IntegrationTestRunner {
  constructor(options = {}) {
    this.name = options.name || 'Integration Suite';
    this.tests = [];
    this.results = { passed: 0, failed: 0, skipped: 0, total: 0 };
    this.startTime = null;
    this.endTime = null;
  }

  test(name, scriptPath, options = {}) {
    this.tests.push({ name, scriptPath, options, timeout: options.timeout || 30000 });
  }

  async run() {
    this.startTime = Date.now();
    console.log(`\n${BOLD}=== ${this.name} ===${RESET}`);

    for (const t of this.tests) {
      this.results.total++;
      const result = await this._runScript(t.scriptPath, t.timeout);
      if (result.success) {
        this.results.passed++;
        console.log(`  ${GREEN}PASS${RESET} ${t.name} (${result.duration}ms)`);
      } else {
        this.results.failed++;
        console.log(`  ${RED}FAIL${RESET} ${t.name}`);
        if (result.output) console.log(`       ${GRAY}${result.output.slice(-200)}${RESET}`);
      }
    }

    this.endTime = Date.now();
    const duration = ((this.endTime - this.startTime) / 1000).toFixed(2);
    console.log(`\n${BOLD}=== Summary ===${RESET}`);
    console.log(`  Total: ${this.results.total} | ${GREEN}Passed: ${this.results.passed}${RESET} | ${RED}Failed: ${this.results.failed}${RESET}`);
    console.log(`  Duration: ${duration}s`);

    // R0-115：套件收尾再收一次（覆盖"最后一个文件桶之后"新增的进程，以及 _runScript 之外
    // 由集成脚本自行 spawn 的残留）。有任何无法回收 → 计入失败，绝不"清不干净还报绿"。
    const leaked = await reapAll();
    if (leaked.length > 0) {
      this.results.failed++;
      console.log(`  ${RED}FAIL${RESET} 子进程回收：${leaked.map((r) => `${r.pid}(${r.label})`).join(', ')} 未能回收`);
    }

    if (this.results.failed > 0) process.exit(1);
  }

  async _runScript(scriptPath, timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      // R0-115：集成脚本同样走受管 spawn（独立进程组 + 登记回收），
      // 这样它内部再 spawn 的孙进程也能整组带走。
      const child = spawnManaged('node', [scriptPath], { cwd: projectRoot, timeout, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';

      child.stdout?.on('data', (d) => { output += d.toString(); });
      child.stderr?.on('data', (d) => { output += d.toString(); });

      child.on('close', (code) => {
        resolve({ success: code === 0, duration: Date.now() - start, output });
      });

      child.on('error', (e) => {
        resolve({ success: false, duration: Date.now() - start, output: e.message });
      });
    });
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

export function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`);
  }
}

export function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(message || 'Expected function to throw');
}

export async function assertRejects(fn, message) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  if (!threw) throw new Error(message || 'Expected async function to reject');
}

// 产物形态判据。**v0.9.25 起，"两棵树"这个概念本身被删掉了。**
//
// 历史（为什么要写在这一段）：v0.9.24 及以前，开发树与发布物的**布局不同**——
//   build-oss 把 `plugins/model-openai.js` 映射成 `plugins/model-openai.js`，
//   并**不复制** `plugins/gateway.js`。于是每个测试都要问"我在哪棵树里"，
//   再按候选目录去解析同一个插件的路径。判据当时是内容标记：
//     `有 plugins/model-openai.js 且无 plugins/gateway.js ⇒ 产物形态`
//
// 两个后果，一个比一个糟：
//   ① 那段逻辑**已经腐烂**：`plugins/gateway.js` 在 commit 1db08e0（R0-103 产物去重）
//      就被删了，devMark 永远是 false，于是**开发树一直被判定为"产物形态"**。
//      表现是"门禁照常执行"，所以没人发现——一个判据错了，但错的方向是"多跑门禁"，
//      看起来一切正常。这正是"绿灯 ≠ 正确"的另一种写法：**判据失效时不会喊**。
//   ② 二十来个测试各自维护一份双路径解析（`['plugins/x.js','plugins/x.js'].find(...)`），
//      每份都要处理"两棵树互为反相"，而这些代码服务的差异**只存在于构建脚本里**。
//
// v0.9.25 合并 `plugins/` 进 `plugins/` 之后，**repo 与 npm 包是同一套布局**
// （`package.json` 的 `files` 白名单就是全部差异：`.git`/`node_modules`/`test-results` 不进包）。
// 所以这里不再"判形态"，只回答一个问题：**要验收的那棵树在哪**。
//   · 有 `dist/oss`（历史构建产物）⇒ 验收它；
//   · 否则 ⇒ 验收本树。**没有第三种答案，也不再返回 null。**
//
// 返回 `form` 保留给报告文案用，但它现在描述的只是"验收对象是哪一棵"，不是"布局长什么样"。
export function detectArtifactForm(root = projectRoot) {
  const dist = join(root, 'dist', 'oss');
  if (existsSync(dist)) return { artifact: dist, form: 'dist/oss（历史构建产物）' };
  return { artifact: root, form: '本树（单一布局：开发树即发布物）' };
}

export function createMockCore(overrides = {}) {
  const capabilities = new Map();
  const services = new Map();
  const listeners = new Map();

  return {
    emit(event, payload) {
      if (!event.includes('.')) throw new Error(`Invalid event name: ${event}`);
      const fns = listeners.get(event) || [];
      fns.forEach(fn => fn(payload));
    },
    emitFast(event, payload) {
      const fns = listeners.get(event) || [];
      fns.forEach(fn => fn(payload));
    },
    // R2/H-03：真实 Core 的已提交事实通知面（观察者异常被隔离）。mock 必须有同一个名字，
    // 否则被测模块调用 `core.emitFact` 时会静默跑偏成 "is not a function"。
    emitFact(event, payload) {
      const fns = listeners.get(event) || [];
      const errors = [];
      for (const fn of fns) {
        try { fn(payload); } catch (err) { errors.push({ event, code: 'observer_error', message: String(err?.message || err) }); }
      }
      return { delivered: fns.length - errors.length, errors };
    },
    on(event, fn, opts = {}) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    off(event, fn) {
      const fns = listeners.get(event) || [];
      listeners.set(event, fns.filter(f => f !== fn));
    },
    offByOwner(owner) {
      for (const [event, fns] of listeners) {
        listeners.set(event, fns.filter(fn => fn._owner !== owner));
      }
    },
    registerCapability(id, def) {
      if (capabilities.has(id)) throw new Error(`Capability ${id} already registered`);
      capabilities.set(id, def);
    },
    command(method, params, timeout = 5000) {
      const cap = capabilities.get(method);
      if (!cap) throw new Error(`Capability ${method} not found`);
      return cap.handler(params);
    },
    registerService(name, obj) {
      services.set(name, obj);
    },
    getService(name) {
      return services.get(name) || null;
    },
    get(key, def) { return def; },
    log() {},
    plugins: new Map(),
    _frozen: false,
    ...overrides,
  };
}
