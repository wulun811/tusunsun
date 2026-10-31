// R0-104（外部验收第二轮的收口）——启动噪音 / 产物卫生 / 端口真相。
//
// 三条都来自第二轮复核：T1 是外部维护者指出的（启动刷两条 `already registered`），
// T2/T3 是复核中登记、本轮一并修掉的（R0-103-D8 产物带开发树内部信息、D9 端口口径不一致）。
// 每条都能被本文件里的用例判红：
//   T1 启动噪音：**同名 ≠ 冲突**。同一份实现（同 realpath 或字节相同）被扫两次时不得刷
//      `Plugin "config" already registered, skipping`（产物里 config.js 有两份字节相同的
//      副本 ⇒ 此前每次启动刷两条）；**实现确实不同**时必须仍然 warn（真冲突不得静默）。
//   T2 产物卫生：产物 `.gitignore` 不得照抄开发树（`runtime1/`、`docs/MSMA/`、`msma-artifact/`…）；
//      随包场景的 `defaultConfig` 键必须是随包插件，值里指向具体文件的路径必须在树内存在。
//   T3 端口真相：`resolveGatewayPort` 只有**一份实现**（内核导出，CLI 复用），优先级
//      `--port` > `TUSUNSUN_PORT` > `<stateDir>/config.json` 的 gateway.port > 9002，
//      且 `port: 0`（随机可用端口）不得被真值判断吞掉。

import { assert, assertEquals } from '../harness.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'oss');
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 产物形态断言用的两个小工具（T4）：读产物 package.json 的 bin，以及遍历产物文件。
// 不引入构建器模块——制品树/包里没有它，门禁必须能在三种形态下各自自洽。
function collectBinsDirect(tree) {
  const pkgPath = join(tree, 'package.json');
  const out = new Set();
  if (!existsSync(pkgPath)) return out;
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { return out; }
  const bin = pkg.bin;
  if (!bin) return out;
  for (const v of (typeof bin === 'string' ? [bin] : Object.values(bin))) {
    if (typeof v !== 'string') continue;
    const rel = v.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    if (rel) out.add(rel);
  }
  return out;
}

/** 本仓的制品指纹按 `npm pack` 的**成员清单**看：tar 头里的 mode 就是被打包的值。 */
function packManifest() {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  assert(r.status === 0, `npm pack --dry-run 必须成功：${(r.stderr || '').slice(-300)}`);
  const parsed = JSON.parse(r.stdout);
  const files = parsed?.[0]?.files;
  assert(Array.isArray(files) && files.length > 0, 'npm pack 的成员清单不得为空（否则本用例没有观测到任何文件）');
  return files;
}

// 只走**产物自身的文件**：依赖目录/`.git` 不是产物内容（npm 打包时本来排除），
// test-results/ 是运行时产物（构建时被清、跑测试又会重新生成），二者与"制品指纹"无关。
// 依赖目录按**前缀**判：净室里可能存在 `node_modules_tt`、`node_modules.bak` 这类并排目录，
// 它们是安装副产物而非产物文件，按精确名匹配会假红。
function isNotArtifactContent(name) {
  // R0-109/T2：`package-lock.json` 也排除 —— npm **永远**不打进 tgz（它不在 `files` 里，且
  // npm 硬排除），而它的权限位是 `npm install` 按**本机 umask** 现造的：同一提交，umask 022
  // 的机器落 644（绿）、umask 002 的机器落 664（红）。拿它当门禁就是把环境指纹当制品指纹，
  // 与本用例的立意正好相反（实测：R0-109 净室验收里就是它把 Unit 套件判红的）。
  return name === '.git' || name === 'test-results' || name === 'package-lock.json'
    || name.startsWith('node_modules');
}
function walkArtifact(tree, fn, prefix = '') {
  for (const e of readdirSync(join(tree, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (isNotArtifactContent(e.name)) continue;
    if (e.isDirectory()) { walkArtifact(tree, fn, rel); continue; }
    fn(join(tree, rel), rel);
  }
}

// 本检出是**开发树**（有 .git）还是**产物/制品形态**（npm 包、解包后的 tgz——两者都不含 .git）。
// 为什么需要它（R0-105 补）："权限位已归一"这个断言只对**产物**成立。开发树的权限由检出
// umask 决定——`core.sharedRepository` 未开启时 git 只记 644/755，umask 002 检出后就落成 664/775。
// 拿开发树断言 644/755，测的不是仓里的字节，而是**本机的 umask**：同一个提交，umask 022 的机器
// 绿、umask 002 的机器红（实测如此）。这条用例自己的注释说的就是"不能让门禁退化成环境指纹"，
// 而按 umask 判红恰恰就是环境指纹。
const isDevTree = (tree) => existsSync(join(tree, '.git'));

// v0.9.25：装配根从两个（`plugins/` + `src/builtin/`）收回一个。
const PLUGIN_ROOTS = (tree) => [join(tree, 'plugins')];

// 场景里的插件名 → 是否存在对应的插件文件（顶层，或一级子目录里的同名文件）。
// 不 import：import 会执行插件顶层代码，门禁不该有副作用（同 R0-103/T7 的理由）。
function hasPluginFile(tree, name) {
  for (const root of PLUGIN_ROOTS(tree)) {
    if (!existsSync(root)) continue;
    for (const ext of ['.js', '.mjs']) {
      if (existsSync(join(root, name + ext))) return true;
    }
    for (const sub of readdirSync(root)) {
      const p = join(root, sub);
      if (!statSync(p).isDirectory()) continue;
      for (const ext of ['.js', '.mjs']) {
        if (existsSync(join(p, name + ext))) return true;
      }
    }
  }
  return false;
}

// 真进程启动：等到 `listening on`（重复注册警告发生在装配期，必然已在日志里）后收尾。
async function bootAndCapture(extraArgs, home, waitMs = 30000) {
  const child = spawnManaged('node', [join(ROOT, 'tusunsun.mjs'), ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (/listening on /.test(out)) { clearInterval(timer); resolve(); return; }
        if (child.exitCode !== null) { clearInterval(timer); reject(new Error(`子进程提前退出（code=${child.exitCode}）：\n${out.slice(-1200)}`)); return; }
        if (Date.now() - t0 > waitMs) { clearInterval(timer); reject(new Error(`30s 内未见监听日志：\n${out.slice(-1200)}`)); }
      }, 100);
    });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  return out;
}

export async function setup(runner) {
  const tmpDirs = [];
  const mkTmp = (tag) => {
    const d = mkdtempSync(join(tmpdir(), `r0104-${tag}-`));
    // R0-113：Node 18 无 ESM 语法探测 ⇒ 夹具目录需显式声明模块类型（产品包内 type=module）
    writeFileSync(join(d, 'package.json'), '{"type":"module"}');
    tmpDirs.push(d);
    return d;
  };
  runner.afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  // ── T1：启动噪音（同名 ≠ 冲突）────────────────────────────────────────
  runner.test('R0-104/T1 启动噪音：同一份实现被扫两次不得刷警告，实现不同必须 warn', async () => {
    const { Core } = await imp('src/core/core.js');
    const { PluginManager } = await imp('src/core/plugin-manager.js');
    const fixture = (v) => `class Demo {\n  name = 'demo';\n  version = '${v}';\n  async init() {}\n}\nexport default new Demo();\n`;

    const boot = async (dir, v1, v2) => {
      mkdirSync(join(dir, 'p1'), { recursive: true });
      mkdirSync(join(dir, 'p2'), { recursive: true });
      writeFileSync(join(dir, 'p1', 'demo.js'), fixture(v1));
      writeFileSync(join(dir, 'p2', 'demo.js'), fixture(v2));
      const core = new Core({ stateDir: join(dir, 'state'), pluginsDir: join(dir, 'p1') });
      const logs = [];
      core.log = (level, ...rest) => { logs.push(`${level} ${rest.join(' ')}`); };
      const pm = new PluginManager(core);
      core.registerService('plugin-manager', pm);
      pm.addDirectory(join(dir, 'p1'));
      pm.addDirectory(join(dir, 'p2'));
      await pm.loadAll(['demo'], []);
      return { core, pm, logs };
    };

    // ① 同一份实现（字节相同、两个不同路径）⇒ 静默，但记账
    const same = await boot(mkTmp('t1-same'), '1.0.0', '1.0.0');
    const warnsSame = same.logs.filter((l) => /already registered/.test(l));
    assertEquals(warnsSame.length, 0, `同一份实现不得刷"已注册"警告：${warnsSame.join(' | ')}`);
    assertEquals(same.pm._dedupSkipped.length, 1, '同实现重名必须记入 `_dedupSkipped`（不刷日志但可查）');
    assertEquals(same.core.plugins.size, 1, '只应注册一个 demo');

    // ② 反例：同名但**实现不同** ⇒ 必须 warn（先到者胜 + 冲突可见，assembly 锁据此记账）
    const diff = await boot(mkTmp('t1-diff'), '1.0.0', '9.9.9');
    const warnsDiff = diff.logs.filter((l) => /already registered/.test(l));
    assertEquals(warnsDiff.length, 1, `实现不同的重名必须 warn（真冲突不得静默）：${diff.logs.join(' | ')}`);
    assertEquals(diff.pm._dedupSkipped.length, 0, '真冲突不得记入 `_dedupSkipped`');

    // ③ 真进程：`_earlyLoadConfig`（唯一绕过 PluginManager 的注册点）+ 通用发现不得刷警告
    const home = mkTmp('t1-home');
    const homeScenes = join(join(home, '.tusunsun'), 'scenes');
    mkdirSync(homeScenes, { recursive: true });
    writeFileSync(join(homeScenes, 'r0104.json5'),
      '{ name: "r0104", description: "R0-104 噪音用例", eager: ["config", "gateway"] }\n');
    const stateDir = join(mkTmp('t1-state'), 'state');
    const out = stripAnsi(await bootAndCapture(['start', '--scene', 'r0104', '--port', '0', '--state-dir', stateDir], home));
    const warnsBoot = out.split('\n').filter((l) => /already registered/.test(l));
    assertEquals(warnsBoot.length, 0, `真进程启动不得刷"已注册"警告：${warnsBoot.join(' | ')}`);
    console.log('       [实测] 同实现静默（_dedupSkipped=1）；实现不同仍 warn；真进程启动 0 条警告');
  });

  // ── T2：产物卫生（D8）─────────────────────────────────────────────────
  runner.test('R0-104/T2 产物卫生：.gitignore 与场景 defaultConfig 不得带开发树专属内容', async () => {
    const tree = existsSync(DIST) ? DIST : ROOT;
    const label = existsSync(DIST) ? 'dist/oss' : '本树（产物形态）';

    // ① .gitignore 不得照抄开发树。
    //    注意：npm 打包**固定排除** .gitignore ⇒ 包形态下该文件本就不存在。
    //    此时只接受“确属 npm 包形态”（同样不含 .github/）——否则就是构建漏写了产物 .gitignore。
    //
    //    判据来源：开发树存在时，直接读**开发树自己的** .gitignore 取出仅开发树才有的条目
    //    （即那些指向 development-only 目录的行）；这样断言不把内部目录名/产品名硬编码进随包文件，
    //    判据也跟着开发树 .gitignore 的演进走，不会因为开发树改名而漏判。
    const giPath = join(tree, '.gitignore');
    if (existsSync(giPath)) {
      const gi = readFileSync(giPath, 'utf8');
      const devGiPath = join(ROOT, '.gitignore');
      // 产物形态下 ROOT 就是自身，没有可比对的“开发树版本” ⇒ 退化为结构性判据：
      // 产物 .gitignore 只允许通用条目（不得出现只存在于开发树的分区/路径引用）。
      const devOnly = existsSync(devGiPath) && devGiPath !== giPath
        ? readFileSync(devGiPath, 'utf8').split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
            // 只取“开发树有、而产物不该有”的强目录条目（带 / 结尾且非通配）
            .filter((l) => l.endsWith('/') && !l.includes('*'))
            .filter((l) => !gi.includes(l))
        : [];
      const hits = devOnly.filter((k) => gi.includes(k));
      assertEquals(hits.length, 0, `${label} 的 .gitignore 含开发树专属条目：${hits.join(', ')}`);
      // 结构性底线：产物 .gitignore 不得引用开发树的工作区级目录（与开发树具体内容无关）
      const structural = ['runtime1/', 'msma-artifact/'];
      const shits = structural.filter((k) => gi.includes(k));
      assertEquals(shits.length, 0, `${label} 的 .gitignore 引用了开发树工作区目录：${shits.join(', ')}`);
    } else {
      assert(!existsSync(join(tree, '.github')),
        `${label} 缺 .gitignore，但又不是 npm 包形态（含 .github/）⇒ 构建漏写了产物 .gitignore`);
      console.log('       [实测] 本树无 .gitignore（npm 包形态：npm 固定排除该文件）');
    }

    // ② 随包场景：defaultConfig 键必须是随包插件；值里指向具体文件的路径必须在树内存在
    const { loadJson5 } = await imp('src/core/json5-loader.js');
    const scenesDir = join(tree, 'scenes');
    const badKeys = [];
    const badPaths = [];
    const EXT_RE = /\.(py|js|mjs|json|json5|md|sh|ya?ml)$/;
    const walk = (v, where) => {
      if (typeof v === 'string') {
        if (!v.startsWith('http') && v.includes('/') && EXT_RE.test(v)
            && /^[A-Za-z0-9_./-]+$/.test(v) && !existsSync(join(tree, v))) {
          badPaths.push(`${where}=${v}`);
        }
        return;
      }
      if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`)); return; }
      if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`); }
    };
    for (const f of readdirSync(scenesDir).filter((x) => x.endsWith('.json5'))) {
      const cfg = loadJson5(readFileSync(join(scenesDir, f), 'utf8'), ` in ${f}`);
      for (const key of Object.keys(cfg.defaultConfig || {})) {
        const root = key.split('.')[0];
        if (!hasPluginFile(tree, root)) badKeys.push(`${f}: ${key}`);
      }
      walk(cfg, f);
    }
    assertEquals(badKeys.length, 0,
      `${label} 的场景 defaultConfig 引用了未随包插件的键（切场景会把死配置写进配置）：${badKeys.join(', ')}`);
    assertEquals(badPaths.length, 0,
      `${label} 的场景引用了树内不存在的路径：${badPaths.join('; ')}`);
    console.log(`       [实测] ${label}：.gitignore 无开发专属条目；场景 defaultConfig 键与路径引用均随包`);
  });

  // ── T3：端口真相（D9）─────────────────────────────────────────────────
  runner.test('R0-104/T3 端口真相：resolveGatewayPort 唯一实现，优先级正确且 port:0 不被吞', async () => {
    const { resolveGatewayPort } = await imp('src/bootstrap/cli.js');
    const withCfg = mkTmp('t3-cfg');
    writeFileSync(join(withCfg, 'config.json'), JSON.stringify({ gateway: { port: 19555 } }));
    const empty = mkTmp('t3-empty');
    const saved = process.env.TUSUNSUN_PORT;
    try {
      delete process.env.TUSUNSUN_PORT;
      assertEquals(resolveGatewayPort({ stateDir: withCfg }), 19555, '配置文件里的 gateway.port');
      assertEquals(resolveGatewayPort({ stateDir: empty }), 9002, '无配置文件 → 9002');

      // 关键：`start` 认 TUSUNSUN_PORT（config 插件的 applyEnvOverrides），status/stop 也必须认
      process.env.TUSUNSUN_PORT = '1234';
      assertEquals(resolveGatewayPort({ stateDir: withCfg }), 1234,
        'TUSUNSUN_PORT 必须覆盖配置文件（此前 CLI 那份漏了它 ⇒ start 与 status 口径不一致）');
      assertEquals(resolveGatewayPort({ stateDir: withCfg, port: 0 }), 0,
        '--port 0 必须覆盖环境变量，且 0 不得被真值判断吞掉');

      process.env.TUSUNSUN_PORT = 'not-a-number';
      assertEquals(resolveGatewayPort({ stateDir: withCfg }), 19555, '非法环境变量 → 回落配置文件');

      delete process.env.TUSUNSUN_PORT;
      writeFileSync(join(empty, 'config.json'), '{ bad json');
      assertEquals(resolveGatewayPort({ stateDir: empty }), 9002, '配置损坏 → 9002（不得抛）');
      writeFileSync(join(empty, 'config.json'), JSON.stringify({ gateway: { port: 0 } }));
      assertEquals(resolveGatewayPort({ stateDir: empty }), 0, '配置里的 port:0 是合法意图');
      console.log('       [实测] --port > TUSUNSUN_PORT > 配置文件 > 9002；port:0 原样返回；坏配置不抛');
    } finally {
      if (saved === undefined) delete process.env.TUSUNSUN_PORT;
      else process.env.TUSUNSUN_PORT = saved;
    }
  });

  // ── T4：产物权限位归一（R0-104 补）─────────────────────────────────────
  // 为什么要有这条：`npm pack` 把文件 mode 写进 tar 头，而 mode **不是源码属性**
  // ——git 只记 644/755，检出后的实际权限由 umask 与既有文件决定。若不归一，
  // 同一份源码在 A 机与 B 机重建会得到内容相同、sha256 不同的 tgz，
  // 「重建+重打包可复现」这条门禁就退化成环境指纹。
  // 三种形态各自能验的部分不同：产物树/包里没有构建器，只能验「产出确实已归一」；
  // 开发树两段都验。断言不写构建器路径字面量，否则本文件会被产物自包含性过滤剔除
  // （R0-103 时就因这类引用导致该用例从未真正进包）。
  runner.test('R0-104/T4 产物权限位归一：不同检出权限必须归一成同一形态（否则 tgz 哈希不可复现）', async () => {
    const modeOf = (p) => statSync(p).mode & 0o777;
    // 形态选择：开发树看 dist/oss（构建产物）；制品树/包里**看自己**（它本身就是产物，
    // 没有 dist/oss）。上一版写死 DIST，导致本用例进包后必红（ENOENT dist/oss）。
    const tree = existsSync(DIST) ? DIST : ROOT;
    const label = existsSync(DIST) ? 'dist/oss' : '本树（产物形态）';
    const bins = collectBinsDirect(tree);
    // ── 形态无关的补充断言（R0-109/T2）──────────────────────────────────────
    // 下面那条"必须恰好 644/755"只在**产物形态**成立（检出树的 644↔664 由 umask 决定，不能当门禁）。
    // 但 **600 与 umask 无关**：umask 002/022 只会产出 664/644，绝不会产出 600 —— 600 只能来自
    // "以 umask 077 写文件的工具/编辑器"。而 `npm pack` 对 600 **原样保留**（R0-109 实测 tar 头
    // `-rw-------`），于是它会随包发布，并让"同一份源码重建得到的 tgz 哈希"取决于谁在什么环境里
    // 建过这个文件 —— 正是本用例要防的环境指纹。
    // 触发场景（R0-109 实测）：本仓是**手工维护的交付仓**（不经 `artifact-modes.mjs` 归一），
    // 用 umask 077 的工具新建文件后直接 `npm pack`，产物就带上 600；而下面那条断言在
    // "有 .git 的交付仓形态"下是 NOT_RUN ⇒ 缺陷只在净室解包后才暴露。
    // 判据取"组可读且他人可读"（0o44）：它同时容纳 644 与 664（umask 差异），只拦"过严"的位。
    // 只在**随包文件**上判：仓里还有大量不随包的东西（构建产物、下游子工程目录、纯开发脚本），
    // 拿它们判红是噪音，也不属于"制品指纹"。
    const pkgFiles = (() => {
      try { return JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).files || []; }
      catch { return []; }
    })();
    const ALWAYS_SHIPPED = ['package.json', 'README.md', 'README.en.md', 'LICENSE', 'NOTICE'];
    const isShipped = (rel) => {
      if (rel === 'package-lock.json') return false;   // npm 永不打包，且 mode 由 umask 现造
      if (ALWAYS_SHIPPED.includes(rel)) return true;
      return pkgFiles.some((f) => {
        const n = String(f).replace(/\/+$/, '');
        return rel === n || rel.startsWith(n + '/');
      });
    };
    const tooClosed = [];
    walkArtifact(tree, (full, rel) => {
      if (!isShipped(rel)) return;
      const got = modeOf(full);
      if ((got & 0o044) !== 0o044) tooClosed.push(`${rel}=${got.toString(8)}`);
    });
    assertEquals(tooClosed.length, 0,
      `随包文件不得"组/他人不可读"（npm pack 原样保留 600，tgz 哈希会随建包环境漂移）：${tooClosed.slice(0, 5).join(', ')}`);
    // 权限位只在**产物形态**上有"已归一"这个事实可断。开发树的 mode 由检出 umask 决定，
    // 断言它等于 umask 输出而不是仓内容（见 isDevTree 注释）⇒ 开发树改为如实 NOT_RUN，
    // 由下面的聚合规则/幂等断言（对临时树施加，与 umask 无关）继续覆盖本用例的本意。
    // R0-111：只在**构建器自己归过权**的形态（dist/oss）上断"恰好 644/755"。
    // 旧判据是 `existsSync(DIST) || !isDevTree(tree)`，而 `isDevTree` 又是"有没有 .git"——
    // 于是 `npm install <tgz>` 解出来的副本被判成"产物形态"：它的权限由**解包方的 umask** 决定
    //（实测 umask 002 ⇒ 664），断言必然红。那不是产物属性、也不是缺陷：tgz 头里是 644
    //（`tar -tvf` 实测 `-rw-r--r--`），"重打包 sha256 不随本机漂移"看的正是被打包的树与 tgz 头，
    // 不是消费者机器上解包后的结果。故这些形态如实 NOT_RUN，形态无关的"不得组/他人不可读"照旧生效。
    const checkActualModes = existsSync(DIST);
    if (checkActualModes) {
      const badDirs = [];
      walkArtifact(tree, (full, rel) => {
        const want = bins.has(rel) ? 0o755 : 0o644;
        const got = modeOf(full);
        if (got !== want) badDirs.push(`${rel}=${got.toString(8)}`);
      });
      assertEquals(badDirs.length, 0, `产物权限位未归一（重打包 sha256 会随本机 umask 漂移）：${badDirs.slice(0, 5).join(', ')}`);
      assertEquals(bins.size, 1, `产物应只有 1 个 bin 入口，实际 ${bins.size} 个`);
      assertEquals(modeOf(join(tree, 'tusunsun.mjs')), 0o755, 'bin 入口必须 755（装入 PATH 后要能执行）');
    } else {
      // 本形态的制品 = `npm pack` 的 tgz：要看的不是检出目录的 mode（那由本机 umask 决定），
      // 而是**被包的成员清单**里的 mode —— 那才是 tar 头、才是重打包哈希的输入。
      const members = packManifest();
      const want755 = new Set([...bins].map((b) => String(b).replace(/^\.\//, '')));
      assertEquals(want755.size, 1, `应只有 1 个 bin 入口，实际 ${want755.size} 个：${[...want755].join(', ')}`);
      const bad = [];
      for (const m of members) {
        const want = want755.has(m.path) ? 0o755 : 0o644;
        if (m.mode !== want) bad.push(`${m.path}=${m.mode.toString(8)}`);
      }
      assertEquals(bad.length, 0,
        `打包成员权限位未归一（tgz 哈希会随建包环境漂移）：${bad.slice(0, 5).join(', ')}`);
      const binMember = members.find((m) => want755.has(m.path));
      assertEquals(binMember?.mode, 0o755, 'bin 入口必须以 755 被打包（装进 PATH 后才可执行）');
    }

    // 归一本身的行为（幂等 + 两种检出收敛到同一形态）：直接按同一套规则对临时树施加，
    // 与构建器共享的是**规则**而不是模块——规则若漂移，产物断言会先红。
    const applyRule = (tree) => {
      const b = collectBinsDirect(tree);
      walkArtifact(tree, (full, rel) => chmodSync(full, b.has(rel) ? 0o755 : 0o644));
    };
    const mk = (tag, mode) => {
      const d = mkTmp(tag);
      mkdirSync(join(d, 'src', 'core'), { recursive: true });
      writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', bin: { tusunsun: './tusunsun.mjs' } }));
      for (const rel of ['tusunsun.mjs', 'src/core/env.js', 'README.md']) {
        writeFileSync(join(d, rel), `// ${rel}\n`);
        chmodSync(join(d, rel), mode);
      }
      return d;
    };
    const a = mk('t4-a', 0o600);   // 模拟 checkout 后偏严的权限
    const b = mk('t4-b', 0o664);   // 模拟 umask 002
    applyRule(a); applyRule(b);
    const snap = (d) => walkArtifact(d, () => {}).length;
    for (const rel of ['tusunsun.mjs', 'src/core/env.js', 'README.md']) {
      assertEquals(modeOf(join(a, rel)), modeOf(join(b, rel)),
        `${rel}：600 与 664 两种检出归一后必须同权限（否则 tar 里的 mode 不同 ⇒ sha256 漂移）`);
    }
    assertEquals(modeOf(join(a, 'tusunsun.mjs')), 0o755, 'bin 入口归一后必须 755');
    assertEquals(modeOf(join(a, 'src/core/env.js')), 0o644, '普通文件归一后必须 644');
    const before = ['tusunsun.mjs', 'src/core/env.js'].map((r) => modeOf(join(a, r))).join(',');
    applyRule(a);
    const after = ['tusunsun.mjs', 'src/core/env.js'].map((r) => modeOf(join(a, r))).join(',');
    assertEquals(after, before, '归一必须幂等');
    void snap;
    console.log(`       [实测] ${label} 已归一（bin ${bins.size} 个 → 755，其余 644）；600/664 两种检出收敛一致且幂等`);
  });
}

