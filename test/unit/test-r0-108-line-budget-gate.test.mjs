// R0-108 / D-5：核心行数预算门禁
//
// 为什么门禁是**测试**而不是脚本：本仓的 `scripts/` 由开发仓构建时按白名单搬运
// （只带 cli 三件 + config-redact），自行新增的脚本**不会随包发布**；
// 而 `test/unit/` 是随包复制的。若把门禁写成脚本，产物里既没有它，引用它的测试还会被
// `pruneNonSelfContainedTests` 剔除 —— 等于没有门禁。写成测试才真正随包、真正在 CI 里跑。
//
// 这道门守两件事：
//   ① `package.json` 的 description 对外**公开承诺**「核心 ≤ 2556 行」；
//   ② 三个"道人"模块各自的**棘轮**预算。
//
// 口径（本仓官方口径，与开发仓 core-limits.mjs 一致）：
//   · 官方门禁口径 = 每文件 `split('\n').length` 之和 = 换行数 + 文件数；
//   · `wc -l` 只数换行，比官方口径少"文件数"行。对外引用行数时必须写明用哪种。
//   （历史上两个 metric 混用，同一份代码被说成 519 和 522 两个数，故此处钉死。）

import { TestRunner, assert } from '../harness.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..');
const CORE_DIR = join(ROOT, 'src', 'core');

// ── 预算：**从 scripts/core-limits.mjs 取，本文件不再自带一份**─────────────────
//
// v0.9.24：此处原本写死 `const CORE_MAX_LINES = 2080;`，并声称"本文件的这两个表就是单一真相"。
// 那是**第二条真相**：`scripts/line-check.js` 读 `scripts/core-limits.mjs`，而本文件读自己的
// 字面量。两者一旦不同步，就出现"门禁绿、承诺红"这种自相矛盾（本轮抬 2080 → 2100 时当场发生：
// `npm run check` 通过，本文件的 D5 失败）。`core-limits.mjs` 文件头明令"其他脚本、文档、测试
// 一律从这里取，禁止再散落字面量"——本文件此前正是被禁的那种写法。
import {
  CORE_MAX_LINES,
  MODULE_BUDGET,
} from '../../scripts/core-limits.mjs';

/**
 * 三个"道人"模块的单模块预算 —— **棘轮（ratchet）**。
 *
 * 2026-10-18：预算改为当时的实测值。这不是"达成了某个历史目标"，而是
 * **把水位钉在今天，此后任何增长都必须显式改这里并被 review 看见**。
 * 原值 157/180/185 是在本仓长期**没有任何行数门禁**的情况下被逐步突破的
 * （实测 163/192/167），此前无人发觉。钉住的净效果是：约束从 0 变成 1。
 *
 * 为什么不去"削 18 行"达标：
 *   ① 本项目自己的教条是"反对为凑行数牺牲可读性"（见开发仓 core-limits.mjs）；
 *   ② 实测没有脂肪——scene-controller 0 行注释、149 行非空，削 6 行就是削逻辑；
 *      三个模块合计只有 56 个空行，唯一"削法"是删空行凑数。
 *
 * R0-111/W1：scene-controller 163 → **172**（+9，已按上面的规矩显式调高）。
 * 增长全部来自一处语义修复：切换 diff 改算"场景声明的全集"（eager ∪ plugins ∪ lazy），
 * 与装配入口 `scenePluginLists()` 同口径——旧判据只看 `plugins`，对
 * base-system/chat/gateway-lite/iot/coding 这些"插件全写在 eager"的场景会输出
 * "没有任何变化"（实测 coding：eager 38、plugins 空）。同一轮已把注释压到 3 行。
 *
 * R0-112：总预算 2500 → **2525**（实测 2519）。增量来自实跑暴露的三处诚实化，全部是
 * **解释性注释 + 判据代码**，不是功能堆积：
 *   · env.js  jsonLogEnabled：日志分流的唯一判据（此前两条流写同一批事件 ⇒ 终端每行两份）；
 *   · core.js `log()` 按判据决定是否发 JSONL（stdout 只做机器流）；
 *   · plugin-manager 把 lazy 索引发布给准入闸门（否则按 eager 校验 ⇒ 假违例 + 生产档拒启动）。
 * 为什么不"削 19 行"达标：沿用本文件已有的判据（见上方三条）——不得为凑行数牺牲可读性。
 * 另注：`src/plugins/secrets.js`（129 行）目前**没有任何生产调用点**，只有单测在测它；
 * 本轮未擅自删/移（属维护者的产品决定），已登记在开发仓 contracts/r0-112-*.md 待裁决。
 */
/** 官方口径：单文件的"行数" = split('\n').length（= 换行数 + 1）。 */
function officialLines(file) {
  return readFileSync(file, 'utf8').split('\n').length;
}

export async function setup(runner) {
  runner.test('R0-108/D5 三道人模块都有预算登记，且登记的模块都真实存在', () => {
    // 双向查：既防"模块被改名后预算变成死登记、该模块从此无人守"，
    // 也防"新道人的模块偷偷上线却没有预算"。
    for (const name of Object.keys(MODULE_BUDGET)) {
      assert(existsSync(join(CORE_DIR, name)),
        `预算表登记了 ${name}，但 src/core/ 下没有该文件——模块被改名/删除后预算成了死登记，`
        + `该模块从此无人守。请同步更新 MODULE_BUDGET。`);
    }
    const present = readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'));
    const daoist = ['scene-controller.js', 'dependency-resolver.js', 'lifecycle-manager.js'];
    for (const name of daoist) {
      assert(present.includes(name), `src/core/ 下应有 ${name}`);
      assert(name in MODULE_BUDGET, `${name} 必须有预算登记（不得无预算上线）`);
    }
  });

  runner.test('R0-108/D5 公开承诺：src/core 总行 ≤ 上限', () => {
    const files = readdirSync(CORE_DIR).filter((f) => f.endsWith('.js'));
    let total = 0;
    for (const f of files) total += officialLines(join(CORE_DIR, f));
    console.log(`       [实测] src/core 总行 ${total}/${CORE_MAX_LINES}（${files.length} 个文件，官方口径）`);
    assert(total <= CORE_MAX_LINES,
      `package.json 对外承诺"核心 ≤ ${CORE_MAX_LINES} 行"，实际 ${total} 行 —— `
      + `要么删代码，要么改承诺，不能让它对不上（口径：split('\\n').length 之和）`);
  });

  runner.test('R0-108/D5 棘轮：三个道人模块各自不得超出预算', () => {
    const over = [];
    const report = [];
    for (const [name, budget] of Object.entries(MODULE_BUDGET)) {
      const n = officialLines(join(CORE_DIR, name));
      report.push(`${name} ${n}/${budget}`);
      if (n > budget) over.push(`${name} ${n}/${budget}（超 ${n - budget}）`);
    }
    console.log(`       [实测] ${report.join('  |  ')}`);
    assert(over.length === 0,
      `以下模块超出棘轮预算：${over.join('、')}。`
      + `这是**有意**的门槛：超了就要么削减，要么显式调高 MODULE_BUDGET 并说明理由——`
      + `不允许"悄悄涨上去"。`);
  });
}
