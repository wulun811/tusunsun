// R0-117：把唯一的运行时依赖 `ws` 从 npm 依赖改成**随仓内置副本**（vendor/ws）之后，
// "自包含"这件事必须有门禁，否则它就是一句自我声明。本文件钉住四件事：
//
//   V1 结构   所有 WebSocket 引用点都走内置路径；全仓不再出现裸包名说明符
//             （内置之后还 import 一次的后果是"两套实现同时在跑"，最难查）
//   V2 完整性 逐文件 sha256 **独立重算**（不采信 verifier 的输出），文件集精确一致
//   V3 有牙   篡改 / 删除 / 新增文件三种漂移，verifier 必须各自变红
//   V4 升级   换过目录内容却不换清单版本 → `--write` 必须拒绝；显式 `--accept-version` 才写
//   V5 漂移   npm 侧版本前进而内置副本没跟 → 必须红（这是"内置"唯一的安全网）
//   V6 行为   内置副本真的能完成一次 RFC 6455 握手 + 子协议协商 + 收发（不是"文件存在"式假门禁）
//   V7 形态   发布物清单零依赖、lock 里没有 ws、`files` 真的带上 vendor/、
//             且被搬到 plugins/ 的 gateway.js 里那个相对路径能解析到产物内
//   V8 自述   README / NOTICE 不再宣称"要装 ws"，而是如实说"内置"
//   V9 验收   install-acceptance 的安装步骤是**离线**的，且断言"什么都没装出来"
//
// 判据写法上的两个坑（本仓踩过，这里刻意规避）：
//   · 本文件不能出现裸包名字面量，否则 V1 的扫描会命中**自己**（同 R0-116 的教训）；
//   · 构建会剔除"引用了不随包路径"的测试文件，故路径一律用 resolve/join 拼，不写字面量。
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { describeCarrier } from '../lib/carrier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const exists = (rel) => existsSync(join(ROOT, rel));

/**
 * 「lock 里不得有 npm 侧 ws」这条前提：源码检出读 lock 实测；npm 发行包**按设计不带**
 * `package-lock.json`（见 ../lib/carrier.mjs）⇒ 该断言由「无 lock」蕴含，并如实写进 [实测]，
 * 而不是静默跳过。制品层面的同类判据由 V7 直接查 tgz 内容 —— 那一条两种载体都能跑。
 */
function lockHasNoNpmSideWs() {
  const lockPath = join(ROOT, 'package-lock.json');
  if (!existsSync(lockPath)) {
    return '本检出无 package-lock.json（npm 打包硬排除）⇒「lock 无 npm 侧 ws」由无 lock 蕴含';
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert(!lock.packages?.[`node_modules/${WS_PKG}`], 'lock 不得有 npm 侧的 ws（发布物已改为内置，有它会诱导 npm ci 去拉包）');
  const rootDeps = lock.packages?.[''] || {};
  assert(!rootDeps.dependencies?.[WS_PKG] && !rootDeps.devDependencies?.[WS_PKG], 'lock 的根条目不得声明 ws');
  return 'package-lock.json 存在，且无 npm 侧 ws 条目';
}

const VENDOR_DIR = 'vendor/ws';
const MANIFEST = join(VENDOR_DIR, 'PROVENANCE.json');
const VERIFIER = join(ROOT, 'scripts', 'verify-vendor.mjs');
const WRAPPER = pathToFileURL(join(ROOT, VENDOR_DIR, 'wrapper.mjs')).href;
const WS_PKG = 'w' + 's';   // 见文件头：不写裸字面量，避免 V1 自命中

/** v0.9.25：装配根只有 `plugins/` 一处（此前要在 `src/builtin/` 与 `plugins/` 之间二选一）。 */
function resolveFile(name) {
  const rel = `plugins/${name}`;
  return exists(rel) ? rel : null;
}

/** 跑 verifier（默认跑本仓；--root 指向临时变异副本）。 */
function runVerifier(args = []) {
  const r = spawnSync(process.execPath, [VERIFIER, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', all: `${r.stdout || ''}${r.stderr || ''}` };
}

/**
 * 复刻一份**整个 `vendor/` 树**到临时根目录，供变异用（每次全新，避免用例间互相污染）。
 *
 * R0-163：此前只拷 `vendor/ws`。加入第二个内置包（`vendor/liuhe-lite`）之后，
 * verifier 在临时根里找不到它 ⇒ `内置依赖目录不存在` ⇒ exit 1。
 * 于是 V4 的"显式接受版本后应写入成功"变成 exit 1 —— 而它要测的**不是**这件事。
 *
 * 两个可能的修法，选后者：
 *   · 让 verifier 在 `--root` 下"只查存在的目录"——那会让真实仓里**丢掉一个内置包**
 *     也不再报错，把唯一的安全网拆了；
 *   · 让变异副本**完整**（本函数）——它本来就是"真仓的一份副本"，不完整是副本的错。
 */
function makeVariantRoot() {
  const root = mkdtempSync(join(tmpdir(), 'tss-vendor-'));
  mkdirSync(join(root, 'vendor'), { recursive: true });
  for (const name of readdirSync(join(ROOT, 'vendor'))) {
    cpSync(join(ROOT, 'vendor', name), join(root, 'vendor', name), { recursive: true });
  }
  return root;
}

function sha256File(file) {
  return 'sha256:' + createHash('sha256').update(readFileSync(file)).digest('hex');
}

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, acc);
    else acc.push(join(full).slice(base.length + 1).split('\\').join('/'));
  }
  return acc.sort();
}

/** 剥注释：结构判据必须看代码，不能被注释里的示例字样满足（R0-115 的教训）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export async function setup(runner) {
  if (!existsSync(join(ROOT, VENDOR_DIR, 'wrapper.mjs'))) {
    runner.test('R0-117 前置：内置副本存在', () => {
      runner.noteSkip(`本检出形态没有 ${VENDOR_DIR}/wrapper.mjs`);
    });
    return;
  }

  // ── V1 结构：引用点 + 全局无裸说明符 ─────────────────────────────────
  runner.test('R0-117/V1 所有 WebSocket 引用点都走内置副本，且全仓不再有裸包名说明符', () => {
    const sites = [
      resolveFile('gateway.js'),
      resolveFile('tui.js'),
      'scripts/cli-transport.mjs',
      'scripts/install-acceptance.mjs',
      'test/lib/cdp.mjs',
    ].filter(Boolean);
    // 五个引用点缺一个就说明"少改了一处"（少改的那处会去 node_modules 找 ws → 装不上就炸）
    assertEquals(sites.length, 5, `WebSocket 引用点应有 5 处，实际解析到 ${sites.length} 处：${sites.join(', ')}`);
    for (const rel of sites) {
      const code = read(rel);
      assert(new RegExp(`['"][^'"]*${VENDOR_DIR}/wrapper\\.mjs['"]`).test(code),
        `${rel} 必须从 ${VENDOR_DIR}/wrapper.mjs 加载（内置后不得回退到 npm 包）`);
    }
    const v = runVerifier(['--json']);
    let parsed;
    try { parsed = JSON.parse(v.out); } catch { throw new Error(`verify-vendor --json 输出不可解析：${v.all.slice(0, 300)}`); }
    assertEquals(parsed.info.bareSpecifiers.length, 0,
      `全仓不得再有裸说明符引用：${JSON.stringify(parsed.info.bareSpecifiers)}`);
    assertEquals(parsed.ok, true, `verify-vendor 应通过：${JSON.stringify(parsed.problems)}`);
  });

  // ── V2 完整性：独立重算哈希，不采信脚本 ───────────────────────────────
  runner.test('R0-117/V2 逐文件 sha256 独立重算与清单一致，文件集精确（多一个少一个都算漂移）', () => {
    const manifest = JSON.parse(read(MANIFEST));
    const live = walk(join(ROOT, VENDOR_DIR)).filter((f) => f !== 'PROVENANCE.json');
    const pinned = Object.keys(manifest.files).sort();
    assertEquals(live.length, pinned.length, `文件数不一致：清单 ${pinned.length} / 实况 ${live.length}`);
    for (const f of live) {
      assert(pinned.includes(f), `${VENDOR_DIR}/${f} 未登记在清单里`);
      assertEquals(sha256File(join(ROOT, VENDOR_DIR, f)), manifest.files[f], `${VENDOR_DIR}/${f} 哈希不符`);
    }
    // 版本号的单一真相是副本自带的 package.json（而不是我们的清单）
    const upstreamPkg = JSON.parse(read(join(VENDOR_DIR, 'package.json')));
    assertEquals(manifest.version, upstreamPkg.version, '清单版本必须等于副本内 package.json 的版本');
    assertEquals(upstreamPkg.name, WS_PKG, '副本内 package.json 的包名应与登记表一致');
    // 许可：MIT 要求随分发附带原文，不能只写一行声明。
    // 判据看**正文**（MIT 原文并不含 "MIT License" 这个字样，只按字样匹配会漏）：
    // 授权段 + 免责段 + 版权人，三段齐全才算原文在。
    const license = read(join(VENDOR_DIR, 'LICENSE'));
    assert(/Permission is hereby granted, free of charge/.test(license), '内置副本必须随附上游 MIT 授权段原文');
    assert(/THE SOFTWARE IS PROVIDED "AS IS"/.test(license), '内置副本必须随附 MIT 免责段原文');
    assert(/Einar Otto Stangvik/.test(license), 'MIT 许可证原文必须保留上游版权人');
    // 副本必须是**未修改**的上游代码（清单里 modified 字段说谎比没有字段更糟）
    assertEquals(manifest.modified, false, '清单必须如实记录"未修改"');
  });

  // ── V3 有牙：三种漂移各自变红 ────────────────────────────────────────
  runner.test('R0-117/V3 篡改 / 删除 / 新增 三种漂移，verifier 必须各自变红（否则清单只是装饰）', () => {
    const cases = [
      {
        name: '改一个字节',
        mutate: (root) => {
          const f = join(root, VENDOR_DIR, 'lib', 'receiver.js');
          writeFileSync(f, readFileSync(f, 'utf8') + '\n// tampered\n');
        },
        expect: /lib[\\/]receiver\.js 内容与清单不符/,
      },
      {
        name: '删一个文件',
        mutate: (root) => rmSync(join(root, VENDOR_DIR, 'lib', 'constants.js')),
        expect: /lib[\\/]constants\.js 清单有、磁盘无/,
      },
      {
        name: '加一个文件',
        mutate: (root) => writeFileSync(join(root, VENDOR_DIR, 'extra-backdoor.js'), 'export const x = 1;\n'),
        expect: /extra-backdoor\.js 不在清单里/,
      },
    ];
    for (const c of cases) {
      const root = makeVariantRoot();
      try {
        c.mutate(root);
        const r = runVerifier(['--root', root]);
        assertEquals(r.code, 1, `[${c.name}] 变异副本必须校验失败（实际 exit=${r.code}）`);
        assert(c.expect.test(r.all), `[${c.name}] 失败信息必须点名具体文件，实际输出：${r.all.slice(0, 400)}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  // ── V4 升级：不许"目录换了、清单悄悄跟走" ─────────────────────────────
  runner.test('R0-117/V4 版本变了却想重写清单时必须先显式 --accept-version（防静默升级）', () => {
    const root = makeVariantRoot();
    try {
      const pkgPath = join(root, VENDOR_DIR, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      pkg.version = '8.20.1';
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
      const refused = runVerifier(['--root', root, '--write']);
      assertEquals(refused.code, 1, `--write 在版本不一致时必须拒绝（实际 exit=${refused.code}）`);
      assert(/拒绝写入/.test(refused.all), `必须给出"拒绝写入"的明确原因，实际：${refused.all.slice(0, 300)}`);

      const accepted = runVerifier(['--root', root, '--write', '--accept-version', '8.20.1']);
      assertEquals(accepted.code, 0, `显式接受版本后应写入成功（exit=${accepted.code}，输出：${accepted.all.slice(0, 300)}）`);
      const after = JSON.parse(readFileSync(join(root, VENDOR_DIR, 'PROVENANCE.json'), 'utf8'));
      assertEquals(after.version, '8.20.1', '清单版本应跟随显式接受的新版本');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── V5 漂移：npm 侧前进而内置副本没跟 ────────────────────────────────
  runner.test('R0-117/V5 npm 侧版本与内置副本不一致（内置副本落后）必须红', () => {
    // 正例事实先摆出来：本仓 lock 里**确实**没有 npm 侧的 ws（发布物已改为内置）。
    // 这让下面“漂移必须红”的判据有了适用前提，也不会被读成“不能用”。
    // npm 发行包不带 lock（打包硬排除）⇒ 这条前提由「无 lock」蕴含，并如实写进 [实测]。
    console.log(`       [实测] 前提：${lockHasNoNpmSideWs()}`);

    // 反例：造一份「npm 侧 8.20.9、内置副本落后」的 lock，漂移探测必须红。
    const root = makeVariantRoot();
    try {
      const lockPath = join(root, 'package-lock.json');
      const fake = {
        name: 'tusunsun', version: '0.0.0', lockfileVersion: 3,
        packages: {
          '': { name: 'tusunsun', version: '0.0.0' },
          [`node_modules/${WS_PKG}`]: { version: '8.20.9', integrity: 'sha512-shape-correct' },
        },
      };
      writeFileSync(lockPath, `${JSON.stringify(fake, null, 2)}\n`);
      const r = runVerifier(['--root', root]);
      assertEquals(r.code, 1, `内置副本落后必须红（实际 exit=${r.code}）`);
      assert(/落后|不一致/.test(r.all), `失败信息应点明"落后/不一致"，实际：${r.all.slice(0, 400)}`);
      const vendorVer = JSON.parse(readFileSync(join(root, VENDOR_DIR, 'package.json'), 'utf8')).version;
      assert(r.all.includes('8.20.9') && r.all.includes(vendorVer),
        `失败信息应同时给出两个版本号（npm 侧 8.20.9 / 内置 ${vendorVer}），实际：${r.all.slice(0, 400)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── V6 行为：内置副本真的能握手、协商子协议、收发 ─────────────────────
  runner.test('R0-117/V6 内置副本完成真实 RFC 6455 回环：握手 + 子协议协商 + 消息往返', async () => {
    const mod = await import(WRAPPER);
    const WebSocketServer = mod.WebSocketServer || mod.default?.WebSocketServer;
    const WebSocket = mod.WebSocket || mod.default;
    assert(WebSocketServer && WebSocket, '内置副本必须导出 WebSocketServer 与 WebSocket');

    const server = new WebSocketServer({
      port: 0,
      host: '127.0.0.1',
      // 与网关同款用法：客户端声明了子协议就必须回选一个，否则浏览器按规范断开
      handleProtocols: (protocols) => (protocols.has('tusunsun.v1') ? 'tusunsun.v1' : false),
    });
    await new Promise((res, rej) => { server.once('listening', res); server.once('error', rej); });
    const port = server.address().port;
    assert(port > 0, '内置 WebSocketServer 必须真的监听一个端口');

    const seen = [];
    server.on('connection', (conn) => {
      conn.on('message', (raw) => conn.send(`echo:${raw}`));
    });

    try {
      const reply = await new Promise((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['tusunsun.v1']);
        const timer = setTimeout(() => { try { ws.terminate(); } catch { /* 已关 */ } rej(new Error('内置 ws 回环超时')); }, 15000);
        ws.on('open', () => { seen.push(ws.protocol); ws.send('ping-117'); });
        ws.on('message', (raw) => { clearTimeout(timer); const v = String(raw); ws.close(); res(v); });
        ws.on('error', (e) => { clearTimeout(timer); rej(e); });
      });
      assertEquals(reply, 'echo:ping-117', '内置副本必须能完成一次真实消息往返');
      assertEquals(seen[0], 'tusunsun.v1', '子协议协商必须真的回选 tusunsun.v1（网关依赖这一点）');
    } finally {
      await new Promise((res) => server.close(res));
    }
  });

  // ── V7 发布形态：零依赖、lock 干净、files 带上、解包后路径仍解析 ────────
  runner.test('R0-117/V7 发布物零依赖：package.json 无 deps/devDeps、lock 无 ws、files 含 vendor/、gateway.js 路径可解析', () => {
    const srcPkg = JSON.parse(read('package.json'));
    assert((srcPkg.files || []).includes('vendor/'), '源 package.json 的 files 必须包含 vendor/（少了它 npm pack 会静默剔除）');
    assertEquals(Object.keys(srcPkg.dependencies || {}).length, 0,
      `发布物不得有任何 npm 依赖，实际：${JSON.stringify(srcPkg.dependencies)}`);
    assertEquals(Object.keys(srcPkg.devDependencies || {}).length, 0,
      `发布物不得带 devDependencies（否则装包时又去拉 npm 侧那份），实际：${JSON.stringify(srcPkg.devDependencies)}`);

    console.log(`       [实测] lock 前提：${lockHasNoNpmSideWs()}；${describeCarrier(ROOT)}`);

    // 真制品：pack 出来解包再看 —— "文件在树里"不等于"真被装进了包"。
    const out = mkdtempSync(join(tmpdir(), 'r117-v7-'));
    const ex = mkdtempSync(join(tmpdir(), 'r117-v7x-'));
    try {
      const p = spawnSync('npm', ['pack', '--pack-destination', out], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
      assertEquals(p.status, 0, `npm pack 必须成功：${(p.stderr || '').slice(-300)}`);
      const tgz = join(out, readdirSync(out).find((f) => f.endsWith('.tgz')));
      const t = spawnSync('tar', ['xzf', tgz, '-C', ex], { encoding: 'utf8' });
      assertEquals(t.status, 0, 'tgz 必须能解包');
      const pkgRoot = join(ex, 'package');
      // 发行包**按设计**不含这两样：它们是仓库专属文件，不是产品内容。
      // 这条正向声明了载体判据的前提 —— 两种载体都能验，不依赖“本检出有没有 lock”。
      assert(!existsSync(join(pkgRoot, 'package-lock.json')), '制品不得含 package-lock.json（npm 打包硬排除）');
      assert(!existsSync(join(pkgRoot, '.github')), '制品不得含 .github/（CI 工作流不是产品内容）');
      assert(existsSync(join(pkgRoot, 'vendor', 'ws', 'wrapper.mjs')), '制品必须含 vendor/ws/wrapper.mjs');
      assert(existsSync(join(pkgRoot, 'plugins', 'gateway.js')), '制品必须含 plugins/gateway.js（网关是必需件）');
      const spec = readFileSync(join(pkgRoot, 'plugins', 'gateway.js'), 'utf8')
        .match(/import\(\s*'(\.[^']*vendor\/ws\/wrapper\.mjs)'\s*\)/);
      assert(spec, 'plugins/gateway.js 必须静态可见地指向 vendor/ws/wrapper.mjs');
      const resolved = resolve(join(pkgRoot, 'plugins'), spec[1]);
      assert(existsSync(resolved), `plugins/gateway.js 的相对路径在制品内解析不到：${spec[1]}`);
      assert(!resolved.startsWith(`..${sep}`) && resolved.startsWith(pkgRoot + sep),
        `解析结果必须落在制品内（不能指回源码树）：${resolved}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(ex, { recursive: true, force: true });
    }
  });

  // ── V8 自述：NOTICE 如实描述"内置" ───────────────────────────────────
  runner.test('R0-117/V8 NOTICE 如实描述 ws 以内置副本随包', () => {
    const notice = read('NOTICE');
    assert(/vendor\/ws/.test(notice), 'NOTICE 必须标明内置副本位置（Apache-2.0 §4(d) 的第三方声明）');
    assert(/MIT License/.test(notice) && /Einar Otto Stangvik/.test(notice), 'NOTICE 必须保留上游版权人与许可证');
  });

  // ── V9 验收脚本：离线安装 + 反向断言"什么都没装" ─────────────────────
  runner.test('R0-117/V9 install-acceptance 的安装步骤必须离线，且断言依赖树为空', () => {
    const code = stripComments(read(join('scripts', 'install-acceptance.mjs')));
    // 必须钉住 **argv 本身**，不能只看文件里出现过 `--offline` 四个字：
    // record() 的标签文字里也有 "install --offline"，第一版判据就是被这行标签满足的
    //（变异验证实测：把 argv 里的 '--offline' 删掉，判据仍绿 —— 典型的假门禁）。
    assert(/'install',\s*'--offline'/.test(code),
      "install-acceptance 传给 npm 的 argv 必须是 ['install', '--offline', ...]（不是标签文字里提一句）");
    assert(/depNames\.length \|\| depsOnDisk\.length/.test(code),
      'install-acceptance 必须反向断言"零依赖"（只断言"装成功"是假门禁）');
    assert(/verify-vendor\.mjs/.test(code), 'install-acceptance 必须让内置副本自证完整性');
    // 不得再有"靠 ws 落盘才算装成功"的旧判据（那是自包含的反面）
    assert(!/install\/ws/.test(code), 'install-acceptance 仍以"ws 落盘"作为安装成功判据');
  });
}

export default setup;
