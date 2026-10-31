// R0-168（rc.19 补充）：**`NOT_RUN` 的准入规则** —— 门禁必须证明它没被滥用。
//
// 背景：本轮复查发现门禁里 7 项 `NOT_RUN` 中有 4 项的**理由是错的**，而且错法各不相同：
//
//   ① `browser-e2e` 说"无浏览器驱动前置"，但那条用例一直在 `test/integration/` 里
//      每轮真跑 —— **前提根本不存在**；
//   ② `multi-cell-same-process` 说"未验证"，但那句理由自己就写着"这不是未验证，
//      是合同拒绝" —— **把设计决定记成了证据缺口**；
//   ③ `expert-original-probes` 说"不宜折算进门禁计数"，于是就连跑都不跑了 ——
//      **"不能算作 PASS" 被偷换成 "不必执行"**；
//   ④ `node-24` 只在"跑不了"时记账，本机真有 24 时这一项直接**从清单消失**。
//
// 四种错法的共同后果是同一个：**读者无法区分"环境不允许"与"我们没去做"**。
// 而 `NOT_RUN` 这个词一旦被这样用，它就不再是一个诚实的标记，而是一个方便的抽屉。
//
// 本文件测两件事：
//   ① **规则层**：`NOT_RUN` 只允许用于"本机确实拿不到前置"的情形，且必须写清缺什么；
//   ② **接线层**：上面那 4 项在门禁源码里**必须存在可执行的验证路径**，
//      不能只有一行 `notRun(...)` 就了事。
//
// 这两层必须都测：只测文案，改个措辞就能骗过；只测接线，文案仍可能把人引向错误结论。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { countFromOutput, verdictFor } from '../../scripts/gate-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GATE = readFileSync(join(ROOT, 'scripts', 'release-gate.mjs'), 'utf8');

export async function setup(runner) {
  // ── ① 规则层：NOT_RUN 的理由必须指明"缺什么前置" ─────────────────────
  runner.test('R0-168/1 NOT_RUN 的理由必须指名缺失的前置，不得只写"没验"/"未覆盖"', async () => {
    // 抓所有 `notRun('id', 'what', 'reason')` 里的 reason 字面量（允许模板串）。
    const calls = [...GATE.matchAll(/notRun\(\s*'([^']+)'\s*,\s*'([^']*)'\s*,\s*(`[^`]*`|'[^']*')/g)];
    assert(calls.length > 0, '没找到任何 notRun(...) 调用 —— 正则与源码形状已脱节，本用例会假绿');

    const vague = [];
    for (const [, id, , rawReason] of calls) {
      const reason = rawReason.slice(1, -1);
      // 必须说出"为什么本机做不到"，而不是"我们没做"。
      const namesPrecondition = /平台|未找到|不在|缺失|未安装|需|无该|只用|不是|当前/.test(reason);
      if (!namesPrecondition) vague.push(`${id}: ${reason}`);
    }
    assertEquals(vague.length, 0,
      `以下 NOT_RUN 没写清缺什么前置（"没验"不是理由，"缺 X"才是）：\n  ${vague.join('\n  ')}`);
    console.log(`       [实测] ${calls.length} 条 NOT_RUN 都指名了缺失的前置`);
  });

  runner.test('R0-168/2 平台类 NOT_RUN 必须由真实平台判定驱动，不得写死', async () => {
    // `if (process.platform !== 'win32') notRun('windows', ...)` —— 这形状是对的：
    // 换到 win32 上它就不再记账。若写成无条件 notRun('windows')，那就是永久免检。
    for (const [id, want] of [['windows', 'win32'], ['macos', 'darwin']]) {
      const guarded = new RegExp(
        `if\\s*\\(\\s*process\\.platform\\s*!==\\s*'${want}'\\s*\\)\\s*notRun\\(\\s*'${id}'`).test(GATE);
      assert(guarded, `${id} 的 NOT_RUN 必须由 process.platform !== '${want}' 守卫（否则在该平台上仍是 NOT_RUN）`);
    }
    console.log('       [实测] windows / macos 两条均由 process.platform 守卫，换平台即失去 NOT_RUN 资格');
  });

  // ── ② 接线层：这 4 项必须真的有可执行路径 ─────────────────────────────
  runner.test('R0-168/3 五个曾误记 NOT_RUN 的项，必须各有可执行的验证路径', async () => {
    // `guard` 是门禁里做 existsSync 判定的**变量名**（不是文件名）：
    //   `const browserTest = join(ROOT, '...'); if (existsSync(browserTest)) {...}`
    // 这个区别踩过：第一版拿**文件名**去匹配 `existsSync(...)`，正则对不上真实形状而假红。
    const must = {
      'browser-e2e': { rel: 'test/integration/chat-ui-browser-security.test.mjs', guard: 'browserTest' },
      'multi-cell-same-process': { rel: 'test/probes/r0-167-single-cell-contract.mjs', guard: null },
      'expert-original-probes': { rel: 'scripts/expert-originals-check.mjs', guard: null },
      // 第五项：`real-paid-model` 曾以"只用免费模型"为由记 NOT_RUN —— 那是**工具链**
      // 的限制，不是**产品**的限制。真实端点用免费模型就测得（上游 usage.cost: 0）。
      'real-model-chain': { rel: 'test/probes/r0-169-real-model-chain.mjs', guard: null },
    };
    for (const [id, { rel, guard }] of Object.entries(must)) {
      assert(existsSync(join(ROOT, rel)), `${id} 的验证载体缺失：${rel}`);
      assert(new RegExp(`id:\\s*'${id}'`).test(GATE),
        `门禁里没有以 ${id} 为 id 的执行项 —— 它又退回成一句声明了`);
      if (guard) {
        assert(new RegExp(`existsSync\\(\\s*${guard}\\s*\\)`).test(GATE),
          `${id} 缺 existsSync(${guard}) 守卫`);
      } else {
        assert(new RegExp(`existsSync\\([^)]*${rel.split('/').pop()}[^)]*\\)`).test(GATE),
          `${id} 缺 existsSync 守卫`);
      }
      assert(new RegExp(`notRun\\(\\s*'${id}'`).test(GATE),
        `${id} 缺 notRun 兜底分支：载体缺失时应如实记 NOT_RUN，不得静默`);
    }
    // node-24 不是固定文件，而是"找到就真跑"：必须同时具备「找」和「跑」两半。
    assert(/function findOtherNodeMajor/.test(GATE), 'node-24 缺少 findOtherNodeMajor：会退回"只在跑不了时记账"');
    assert(/id:\s*`node-\$\{n\.major\}`/.test(GATE), 'node-24 没有真的 runOnce 去跑别的版本');
    console.log(`       [实测] ${Object.keys(must).length} 项有载体 + 守卫 + notRun 兜底，node-24 有"找 + 跑"两半`);
  });

  runner.test('R0-168/4 发布物形态缺 verification/ 时，原件对账必须记 NOT_RUN 而不是 FAIL', async () => {
    // 这一条是**只在制品里才会翻车**的那类缺陷，源码树里永远绿 —— 所以必须单独钉住。
    //
    // 症状：`scripts/expert-originals-check.mjs` 会被打进 npm 包，但 `verification/`
    // 不进包。第一版在目录缺失时 `exit(2)`，而门禁把退出码 2 判 **FAIL** ——
    // 于是"源码树全绿、制品门禁红"，恰好红在发布判定那一步。
    //
    // 判据有三层，缺一不可：
    const checker = readFileSync(join(ROOT, 'scripts', 'expert-originals-check.mjs'), 'utf8');
    // ① 脚本自己能区分"制品形态"与"源码树被删证据"
    assert(/existsSync\(join\(ROOT,\s*'verification'\)\)/.test(checker),
      '对账脚本没有区分「发布物形态（本就没有 verification/）」与「源码树里证据被删」');
    assert(/process\.exit\(3\)/.test(checker), '发布物形态必须退出码 3（NOT_RUN），不能用 2（FAIL）或 0（PASS）');
    // ② 门禁这一项必须用 `probe` 证据口径，否则退出码 3 会被当 FAIL
    assert(/id:\s*'expert-original-probes'[\s\S]{0,400}?evidence:\s*'probe'/.test(GATE),
      "expert-original-probes 未使用 evidence:'probe' —— 退出码 3 会被判成 FAIL");
    // ③ 规则层端到端确认：退出码 3 + probe 口径 ⇒ NOT_RUN（不是 FAIL、不是 PASS）
    const v = verdictFor({ exitCode: 3, failed: countFromOutput('', 'Failed'), skipped: null, total: null, evidence: 'probe' });
    assertEquals(v.status, 'NOT_RUN', `退出码 3 在 probe 口径下必须判 NOT_RUN，实际 ${v.status}`);
    // 反向：若误用 `tool` 口径，同一个退出码就成了 FAIL —— 这正是第一版的错法
    const wrong = verdictFor({ exitCode: 3, failed: null, skipped: null, total: null, evidence: 'tool' });
    assertEquals(wrong.status, 'FAIL', '反向自检失败：tool 口径下退出码 3 本应是 FAIL（说明判据本身变了）');
    console.log('       [实测] 制品形态 → rc=3 → NOT_RUN；误用 tool 口径 → FAIL（反向自检成立）');
  });

  runner.test('R0-168/5 NOT_RUN 的理由不得把「工具链约束」写成「产品约束」', async () => {
    // 这一条是本轮最实际的教训：`real-paid-model` 曾是 `NOT_RUN`，理由是
    // 「本轮只用免费模型，未在付费端点实测」。
    //
    // 那句话是**开发代理的模型选择**，跟**产品能不能接真实上游**是两件事：
    //   · 我跑在哪个模型上 → 工具链环境；
    //   · 产品连不连得上真实端点 → 产品能力，用免费模型完全测得了。
    //
    // 实测反证：`.env` 是免费模型 `deepseek-v4.1-flash` + 真实端点，产品经自己的网关
    // 打真实请求返回 200，上游 `usage.cost: 0`。**付费与否是账号计费方式，不是代码路径。**
    //
    // 把工具链约束写成产品约束的后果很具体：一条本可以真跑的验证被永久搁置，
    // 而"真实上游接得上"这件事在门禁里从此无人验证。
    // 只看**实际被测的字符串**，不看注释。
    // 第一版直接对整份源码跑正则，结果命中的是我自己写在注释里的反面教材说明
    // （"本轮只用免费模型…"那段就是在解释**为什么它错**）—— 判据范围开得太大，
    // 把"讨论这个反模式"当成了"犯了它"。这与门禁里 `countFromOutput` 踩过的坑同型：
    // 文档在**讨论**某个字符串，却被当成**输出了**那个字符串。
    //
    // 正确的范围：`notRun('id', 'what', 'reason')` 里的 reason 字面量。
    const reasons = [...GATE.matchAll(/notRun\(\s*'([^']+)'\s*,\s*'[^']*'\s*,\s*(`[^`]*`|'[^']*')/g)]
      .map((m) => ({ id: m[1], reason: m[2].slice(1, -1) }));
    assert(reasons.length > 0, '没抓到任何 notRun 理由 —— 正则与源码形状脱节，本条会假绿');
    const banned = [
      /本轮只用免费模型/,        // 说"我用的模型"，不是"产品缺什么"
      /未在付费端点实测/,        // 付费与否不构成产品前置
    ];
    for (const { id, reason } of reasons) {
      for (const re of banned) {
        assert(!re.test(reason),
          `NOT_RUN 项 ${id} 把工具链约束当产品约束：「${reason}」`
          + `（命中 ${re.source}）。免费模型就能测真实端点`);
      }
    }
    // 正向：真实链路必须有真跑项，且**不允许**再用旧 id 记 NOT_RUN
    assert(/id:\s*'real-model-chain'/.test(GATE), '真实模型链路没有可执行项');
    assert(!/notRun\(\s*'real-paid-model'/.test(GATE),
      "real-paid-model 仍在无条件记 NOT_RUN —— 应改为 real-model-chain 真跑，缺凭据时由探针返回 3");

    // 探针本身必须能把"缺凭据"如实报成退出码 3，而不是崩或假绿
    const probe = readFileSync(join(ROOT, 'test/probes/r0-169-real-model-chain.mjs'), 'utf8');
    assert(/process\.exit\(3\)/.test(probe), '真实链路探针缺凭据时必须退出码 3（NOT_RUN），不得假绿');
    assert(/chat-roundtrip/.test(probe) && /reply\.trim\(\)\.length > 0/.test(probe),
      '真实链路探针必须判"回复非空"，不能只看 HTTP 200 —— 200 空回复是真实存在的失败形态');
    assert(/bad-credential-rejected/.test(probe),
      '真实链路探针缺坏凭据反向自检：无法排除"上游 401 被吞成 200"');
    console.log('       [实测] 工具链约束未被当作产品约束；真实链路探针判回复非空且有坏凭据反检');
  });

  runner.test('R0-168/6 同一份证据不得记两笔账（具名项与通用探针循环必须互斥）', async () => {
    // 防一种隐蔽的"数字变好看"：同一探针既进通用 `probe:*` 循环、又以具名 id 跑一次，
    // PASS 直接 +1，而证据并没有变多。
    const named = [...GATE.matchAll(/NAMED_PROBES\s*=\s*new Set\(\[([^\]]*)\]\)/g)];
    assert(named.length === 1, '找不到 NAMED_PROBES 定义');
    const listed = [...named[0][1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert(listed.length > 0, 'NAMED_PROBES 为空：具名项会被通用循环重复执行');

    // 正则刻意不用 `[^)]*` —— 循环里有 `f.endsWith('.mjs')`，自带括号会把死板的正则截断
    // （第一版就是这么假红的）。
    assert(/NAMED_PROBES\.has\(f\)/.test(GATE), '通用探针循环没有排除 NAMED_PROBES —— 会重复记账');
    assert(/!\s*NAMED_PROBES\.has\(f\)/.test(GATE),
      'NAMED_PROBES.has(f) 前必须取反（!），否则"排除"变成了"只跑这些"');

    for (const f of listed) {
      assert(existsSync(join(ROOT, 'test/probes', f)), `NAMED_PROBES 里的 ${f} 不存在`);
      assert(new RegExp(`args:\\s*\\[join\\('test/probes',\\s*'${f}'\\)\\]`).test(GATE),
        `${f} 被排除出通用循环，却没有在别处被具名执行 —— 那就等于漏跑`);
    }
    console.log(`       [实测] ${listed.length} 个具名探针已被通用循环排除，且各自具名执行一次`);
  });


}
