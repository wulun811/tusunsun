// R0-65（专家交付3）：正式 OSS 产物的**真实**验收 —— 产物能启动、README 承诺可兑现。
//
// 专家原话：「先在隔离目录对真正 build-oss 产物验证：CLI/bin→Task 创建/运行→Capability/可选
// Scene→具体工具执行→状态/证据→交付/失败恢复。查清现有实际调度路径；不能因为不存在名为
// tool-executor.js 的文件就判定缺执行器，更不能先编一个类出来。只有真实运行缺能力才最小补齐。
// 正式产物缺 Task/执行/证据任何必要环节就不得声称可用。」
// 「README 首页写使用价值、目标用户、适用边界、五分钟示例。最少两条真实旅程：
//  ①没有模型 API key：能安装、--help、自检/列能力和场景…；②配置实际受支持的模型/key后完成一次真实任务。
//  默认模型名、配置路径、真实可用 CLI 命令都要照源码和验收填写；未实测的 tusunsun chat、
//  npm 全局安装或程序化 API **不准在 README 编造**。」
//
// R0-109/T2：**形态自适应**。本文件此前所有用例都写成 `if (!existsSync(dist/oss)) NOT_RUN`，
// 后果是：交付物自带的那份 `npm test` 在净室解包后运行时，E1–E5 五条**全部 SKIP**——而这里是
// "README 承诺"唯一被机器核对的地方。也就是说 README 的每条声称（四条离线命令真能跑、行数目
// 是真的、默认模型名是真的、边界没被夸大）在**用户真正拿到的那个形态**里从未被验证过。
// 三种形态：
//   · 有 dist/oss            → 验 dist/oss（开发树）
//   · 无 dist/oss 且无 .git  → 验**本树自己**（npm 包 / 解包后的 tgz，它本身就是产物）
//   · 无 dist/oss 但有 .git  → 如实 NOT_RUN（那是源码检出，不是"用户拿到的产物"）

import { TestRunner, assert, assertEquals, detectArtifactForm } from '../harness.mjs';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
// R0-115：子进程一律走受管 spawn（独立进程组 + 登记回收）。
import { spawnManaged } from '../lib/proc.mjs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'dist', 'oss');

// R0-111/W2：形态判据改为**按内容判**（`detectArtifactForm`）。旧判据带 `.git` 就判"源码检出"，
// 于是交付仓（= git 检出 + 产物）里 E1–E5 全部静默 NOT_RUN——交付仓的唯一验收环境里门禁不执行。
const { artifact: ARTIFACT, form: FORM } = detectArtifactForm(ROOT);
const FORM_LABEL = FORM || '源码检出（未构建）';

// R0-101：产物的**已发布插件面**（精确清单）。改动此表 = 一次发布审查动作：
// 任何新增/删除都必须在这里显式登记，避免"未审内容随包"。
const PUBLISHED_PLUGINS = [
  'channel-base.js', 'chat-ui.js', 'config.js', 'gateway.js',
  'haotian-lite.js', 'health.js', 'heartbeat.js', 'kunxiansuo-local.js',
  'model-openai.js', 'plugin-context.js', 'scene-switch-listener.js', 'session.js',
  'tools', 'workspace.js', 'ying-mini.js',
  'cell-runtime.js',
  // v0.9.22（CTX）：Cell 认知侧。逐个登记，理由写在同一处：
  //   · cell-context.js      —— profile → Cell 身份的可信绑定（宿主授权落在这一层）
  //   · context-port.js      —— ContextPort 服务 + 两个受控工具（tool-context-map/pull）
  //   · experience-port.js   —— 经验层薄接口 + 静态 provider + tool-experience-pull
  //   · compaction.js        —— 结构化摘要 provider（Cell 范围持久化）
  'cell-context.js', 'context-port.js', 'experience-port.js', 'compaction.js',
  // v0.9.24（结构）：`plugins/` 的一级条目分**两种**，此前混在一起：
  //   · 一级 .js 与 `tools/` —— **插件**（有 name + init，被 PluginManager 装载）；
  //   · `_lib/`            —— **辅助模块容器**（无插件入口，只被 import）。
  // 此前 `cell/` `context/` `kunxiansuo/` `context-budget.js` `diagnostic-lite.js`
  // 与插件平铺在同一层，于是"是不是插件"只能靠读文件判断；而
  // `resolvePluginDirs` 把 `plugins/` 下**每个一级子目录**都当插件目录扫描，
  // 这五个非插件项一直在被反复扫描、反复跳过。
  // 现在它们统一收进 `_lib/`，一级条目**语义唯一**：是插件，或是 `_lib`。
  '_lib',
  // v0.9.25：`src/builtin/` 并入 `plugins/`。这是一次**结构合并，不是发布面扩张**——
  // 那批文件本来就是插件（都有 name + init，此前由 cli.js 里第二处
  // `pm.addDirectory(dir('../builtin'))` 装载），只是换了落点。总数与上一版相同。
  // 分两类记，因为职责不同：
  //   ① 平台底座（准入/装配锁/事件出口/隐私/就绪/运行时/沙箱）
  'admission-gate.js', 'agent.js', 'assembly-lock.js', 'event-sink.js',
  'privacy.js', 'readiness.js', 'runtime-env.js', 'sandbox.js',
  //   ② 上下文与工具链（执行器/护栏/加载器/规范化/内建工具）与 CLI 提供者 tui.js
  'context-manager.js', 'prompt-builder.js', 'prompt-template.js',
  'tool-executor.js', 'tool-guard.js', 'tool-loader.js', 'tool-normalizer.js',
  'tools.js', 'tui.js',
  // v0.9.33（E3）：场景**声明↔实况**诊断。它是插件（有 name + init），
  // 提供 `scene.inspect` 能力与 `scene-inspect` 服务，不改装配行为、只读观测。
  // 落在这里而不是 `src/core/`：诊断有 150 行，而 scene-controller 的单模块预算已满；
  // 更重要的，"声明与实况是否一致"是可失败的观测问题，不该在内核里长。
  'scene-inspect.js',
  // v0.16.0-rc（R3 / E4）：受控多文件事务器官。**这是一次发布面扩张，必须显式登记**——
  // 它不只是“又一个工具”：它把跨文件提交/条件撤销的语义引进了发布面，
  // 而跨文件原子性**不承诺**（逐文件提交、如实报 partial）。
  'cell-file-txn.js',
  // v0.13.0（R0-163）：六合 Lite 适配层。**这是一次发布面扩张，必须显式登记**——
  // 它不是"又一个工具"，而是本包第一次随附**第三方代码**（`vendor/liuhe-lite/`，
  // 43 文件 / 474 KB / 7 201 行）。登记在这里等于回答"审查时它在不在发布物里"。
  //
  // 三点必须同时成立，缺一条这条登记就不该存在（见 ADR-07 §2/§3/§4）：
  //   · 不默认装配（不进任何 scene 的 eager/plugins）——发布面变大，默认行为不变；
  //   · 第三方副本有 sha256 清单且双向核对（`verify-vendor` 的 ④/⑤）；
  //   · `apply`/`undo` 不对模型可见（只走能力面），披露权留在宿主。
  'liuhe-lite.js',
  // v0.16.0-rc.26（K24 §6-D）：回收策略的参考实现。**这是一次发布面扩张，必须显式登记**——
  // 它把「哪些懒插件该回收」从内核的一段注释搬成一个可装卸的实现：内核零改动、不默认装配
  // （不进任何 scene 的 eager/plugins）。没有它，`recycle-advisor` 这个角色名就只是一句
  // 没人兑现的话；有了它，"策略可替换"才是可证的事实（`test-rc26-dedup-equivalence` L/M）。
  'recycle-advisor.js',
  // 注意：`danger-patterns.js`、`destructive-gate.js`、`model-endpoint.js`、`tool-policy.js`
  // 也来自 `src/builtin/`，但它们**不是插件**（没有 name/init），审查后落进 `_lib/`。
  // 本表只登记 `plugins/` 的**一级条目**，所以它们不出现在这里——这由 S7 双向守住：
  // 一级 .js 必须是插件，`_lib` 里必须不是插件。
];

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, ...opts });
  return { code: r.status ?? (r.error ? 127 : 0), out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** 子进程环境必须干净：环境里的 TUSUNSUN_* 会盖过 `HOME`/`--state-dir`，让"离线命令"跑偏。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.TUSUNSUN_STATE_DIR;
  delete env.TUSUNSUN_PORT;
  return env;
}

export async function setup(runner) {
  runner.test('R0-65/E1 产物存在性与规模（未构建则 NOT_RUN，不伪造）', () => {
    if (!ARTIFACT) {
      runner.noteSkip('[NOT_RUN] 既无 dist/oss 也不是产物形态（源码检出）—— 先跑 npm run build:oss');
      return;
    }
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) { if (['node_modules', '.git'].includes(e.name)) continue; walk(p); }
        else files.push(p);
      }
    };
    walk(ARTIFACT);
    // R0-99：本门原先按"210 文件"校准，其中含 67 件**只能在开发树里跑**的下游/兼容树用例。
    // R0-99 按"自足性"把这些用例从 OSS 树剔除（逐件具名，见 r0-99 审计 §二/§三），
    // 产物规模随之合理下降到 168。故规模门改为**分口径**：
    //   · 产品侧（非 test/）不得缩水 —— 这才是"产物塌缩"的真信号；
    //   · test/ 允许随自足性调整，只保一个下限，防止被清空。
    // R0-103（开源盘点 #7）：产品侧**有意**再减 9 件 —— 产物 `plugins/` 里与 `plugins/`
    // 同名的"注册被跳过的死副本"不再复制（126 → 117）。这不是塌缩：插件面仍由 E5 精确锁定
    // （plugins/ 恰好等于已发布插件集），这里只把下限随之下调，保留"防清空"语义。
    //
    // R0-109/T2：**规模门槛只在 dist/oss 形态成立**。包形态的文件集由 package.json 的
    // `files` 白名单 + npm 的硬排除（`.github/`、`engines/`、`package-lock.json` 都不进 tgz）
    // 决定，两个形态的基线本就不同（实测 dist/oss 166 件 / tgz 156 件），拿同一个下限判会把
    // "npm 白名单正常生效"误判成"产物塌缩"。包形态的"没缺东西"由下面的必备件 + E5 的插件面
    // 精确锁定来保证。
    const staged = files.filter((f) => !f.endsWith('.tgz'));
    const product = staged.filter((f) => !relative(ARTIFACT, f).startsWith(`test${sep}`));
    if (existsSync(DIST)) {
      assert(product.length >= 110, `产品侧文件数应达 110+（产物塌缩？实际 ${product.length}）`);
      assert(staged.length >= 150, `产物文件数应达 150+，实际 ${staged.length}`);
    }
    console.log(`       [实测] ${FORM_LABEL}：${staged.length} 个文件（产品侧 ${product.length}）`);

    // 必备件：形态无关
    for (const req of ['tusunsun.mjs', 'package.json', 'LICENSE', 'README.md', 'src/core/core.js',
      'plugins/gateway.js', 'plugins/model-openai.js', 'plugins/haotian-lite.js']) {
      assert(existsSync(join(ARTIFACT, req)), `产物应含 ${req}`);
    }
  });

  runner.test('R0-65/E2 依赖闭包完整：产物启动时零 Cannot-find-module（含被搬移文件的相对导入）', async () => {
    if (!ARTIFACT) { runner.noteSkip('[NOT_RUN] 非产物形态'); return; }

    // 读码级：被 build-oss 搬移/改写的文件，其相对导入必须指向产物内**实际存在**的文件
    const hl = readFileSync(join(ARTIFACT, 'plugins', 'haotian-lite.js'), 'utf8');
    for (const imp of [...hl.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
      const resolved = join(ARTIFACT, 'plugins', imp);
      assert(existsSync(resolved), `haotian-lite 的相对导入必须存在：${imp} → ${resolved}`);
    }
    // tools 共享库必须随白名单工具一起发布
    const toolRead = readFileSync(join(ARTIFACT, 'plugins', 'tools', 'tool-read.js'), 'utf8');
    for (const imp of [...toolRead.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1])) {
      const resolved = join(ARTIFACT, 'plugins', 'tools', imp);
      assert(existsSync(resolved), `tool-read 的相对导入必须存在：${imp}`);
    }

    // 实测启动：确认无模块缺失并能进入 READY。
    //
    // D-4（用户令：测试不该每次磨半天）：此前这里用 `spawnSync(..., timeout: 40000)` 跑
    // `tusunsun start`。但 `start` 是**常驻服务**——进入 READY 之后**不会自己退出**，于是
    // spawnSync 只能把 40s 超时耗满，再以 exit=1 收场（本用例却因为只断言"输出里有 READY"
    // 而照样变绿）。实测：READY 在第 0.6s 就已打印，剩下 39.4s 纯粹在等超时。
    //
    // 这是**测试设计缺陷**：用阻塞式 API 去等一个永不退出的进程，既慢，又把"超时被杀"
    // 当成正常路径——真出现挂死时反而看不出区别。
    //
    // 现改为：spawn 事件驱动，**看到 READY 立即回收**；只有真的超时才判红。
    // 端口同样改为运行时随机：固定 19911 会因宿主占用而假红。
    const home = mkdtempSync(join(tmpdir(), 'r065-home-'));
    const port = String(20000 + Math.floor(Math.random() * 20000));
    const child = spawnManaged(process.execPath, [join(ARTIFACT, 'tusunsun.mjs'), 'start', '--port', port], {
      cwd: ARTIFACT,
      env: cleanEnv({ HOME: home }),
    });
    let out = '';
    const outcome = await new Promise((resolve) => {
      const killTimer = setTimeout(async () => {
        // R0-115：超时也要**整组**回收（先 SIGTERM 给网关一次正常收尾机会），
        // 只 kill 网关本身会把它的引擎孙进程留成孤儿。
        await child.reap();
        resolve({ ok: false, why: '[FAIL] 启动 20s 内未见 READY（挂死或模块缺失）' });
      }, 20000);
      const onData = (d) => {
        out += d;
        if (/READY|ready/.test(out)) {
          clearTimeout(killTimer);
          child.reap().then(() => resolve({ ok: true }));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { clearTimeout(killTimer); resolve({ ok: false, why: `[FAIL] 启动失败：${e.message}` }); });
    });
    // R0-115：reap() 内部已等到进程组真的消失（SIGTERM → 宽限 → SIGKILL 整组），
    // 不再需要原先"再等 3s 看出没退"的补丁——那正是孤儿留下的窗口。
    try {
      assert(!/Cannot find module/.test(out),
        `产物启动不得有模块缺失：\n${out.split('\n').filter((l) => /Cannot find module/.test(l)).slice(0, 4).join('\n')}`);
      assert(outcome.ok, `${outcome.why}：${out.slice(-400)}`);
      console.log(`       [实测] ${FORM_LABEL} 启动：0 个 Cannot-find-module，进入 READY（端口 ${port}，就绪即回收，不空等超时）`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  runner.test('R0-65/E3 README 旅程①逐条实测：四条离线命令必须真实可用（exit 0）', () => {
    if (!ARTIFACT) { runner.noteSkip('[NOT_RUN] 非产物形态'); return; }
    const home = mkdtempSync(join(tmpdir(), 'r065-h2-'));
    try {
      const cases = [['--version'], ['--help'], ['plugins'], ['scene', 'list']];
      for (const args of cases) {
        const r = spawnSync(process.execPath, [join(ARTIFACT, 'tusunsun.mjs'), ...args], {
          cwd: ARTIFACT, encoding: 'utf8', timeout: 120000,
          env: cleanEnv({ HOME: home }),
        });
        assertEquals(r.status, 0, `README 承诺的 \`tusunsun ${args.join(' ')}\` 必须 exit 0，实际 ${r.status}`);
        assert(`${r.stdout}`.trim().length > 0, `\`${args.join(' ')}\` 应有输出`);
      }
      console.log(`       [实测] ${FORM_LABEL} 旅程① 四条离线命令全部 exit 0（无需网络/key）`);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  runner.test('R0-65/E4 README 事实一致性：行数、默认模型名、未实测项不得编造', () => {
    if (!ARTIFACT) { runner.noteSkip('[NOT_RUN] 非产物形态'); return; }
    const readme = readFileSync(join(ARTIFACT, 'README.md'), 'utf8');

    // 1) 核心行数必须与真实一致（此前渲染成"0 行"是缺陷）
    let coreLines = 0;
    const coreDir = join(ROOT, 'src', 'core');
    for (const f of readdirSync(coreDir)) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) coreLines += readFileSync(join(coreDir, f), 'utf8').split('\n').length;
    }
    assert(readme.includes(`微内核 ${coreLines} 行`), `README 行数必须为真实值 ${coreLines}`);
    assert(!/微内核 0 行/.test(readme), 'README 不得出现"微内核 0 行"');

    // 2) 默认模型名必须与源码一致
    const modelSrc = readFileSync(join(ARTIFACT, 'plugins', 'model-openai.js'), 'utf8');
    const m = modelSrc.match(/model:\s*(?:tierCfg\.model\s*\|\|\s*)?base\.model\s*\|\|\s*'([^']+)'/);
    assert(m, '应能从源码解析默认模型名');
    assert(readme.includes(m[1]), `README 必须写明真实默认模型名 ${m[1]}`);

    // 3) 必须写明"无 key 会怎样"（具名说明，而非静默失败）
    assert(/没有 key 会怎样|没有 key/.test(readme), 'README 必须具名说明缺 key 时的行为');
    // 4) 必须给出适用边界（trusted-local-only）
    assert(/trusted-local-only/.test(readme), 'README 必须写明 trusted-local-only 边界');
    // 5) 不得宣传未验证能力
    for (const bad of [/exactly-once/i, /强沙箱/, /不可信输入.*安全/]) {
      const lines = readme.split('\n').filter((l) => bad.test(l));
      for (const l of lines) {
        assert(/不承诺|不得|不支持|不保证/.test(l), `不得正面宣传未验证能力：${l.trim()}`);
      }
    }
    // 6) R0-111/W10：安装段不得给读者一个**装不上**的第一步。
    //    实测（2026-10-18）：`npm view tusunsun` → 404，包还没发布；而 README 原先直接写
    //    `npm install -g tusunsun`。一个失败的第一步会让后面所有步骤都无从验证。
    const installSection = readme.includes('### 安装') ? readme.split('### 安装')[1].split('###')[0] : '';
    assert(installSection.length > 0, 'README 必须有「安装」段');
    if (/npm install -g tusunsun/.test(installSection)) {
      assert(/尚未发布|未发布|404/.test(installSection),
        'npm 渠道未发布时，README 不得直接写 `npm install -g tusunsun` 而不加说明');
    }
    assert(/npm pack|node tusunsun\.mjs/.test(installSection),
      '安装段必须给出当前**真正可用**的获取方式（源码运行或自建 tgz）');

    console.log(`       [实测] ${FORM_LABEL} README 行数=${coreLines}、默认模型=${m[1]}、边界与缺 key 说明齐备、安装段与渠道现状一致`);
  });

  runner.test('R0-65/E5 能力边界如实记录：产物插件面恰好等于已发布集（不得声称具备下游平面）', () => {
    if (!ARTIFACT) { runner.noteSkip('[NOT_RUN] 非产物形态'); return; }
    // R0-101：把"点名校验某个下游目录不在产物内"升级为**精确面校验**——产物 plugins/ 必须
    // 恰好等于已发布插件集；任何未审内容随包（多一个目录/文件）都会在这里失败，而不只是某一个已知名字。
    const shippedPlugins = readdirSync(join(ARTIFACT, 'plugins')).sort();
    const published = [...PUBLISHED_PLUGINS].sort();
    const extra = shippedPlugins.filter((n) => !published.includes(n));
    const lost = published.filter((n) => !shippedPlugins.includes(n));
    assert(extra.length === 0 && lost.length === 0,
      `产物 plugins/ 必须恰好等于已发布插件集；多出[${extra.join(',')}] 缺失[${lost.join(',')}]`);
    const readme = readFileSync(join(ARTIFACT, 'README.md'), 'utf8');
    // 因此 README 不得声称本包提供 Task→交付 闭环
    for (const line of readme.split('\n')) {
      if (/Task.*交付|交付.*闭环/.test(line)) {
        assert(/不|未|暂/.test(line), `OSS 无 Task 平面，不得声称交付闭环：${line.trim()}`);
      }
    }
    console.log(`       [实测] ${FORM_LABEL} 为对话型 Agent 内核（18 插件 + 10 工具），无 Task/交付平面`);
  });
}
