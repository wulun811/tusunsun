// Core 的**唯一预算来源**。改数字就是改发布承诺：必须走 ADR 并被 review 看见。
//
// 官方行数口径：每个文件 `content.split('\n').length` 之和（= 换行数 + 文件数）。
// 预算是**棘轮**：等于实测值；任何增长都要先腾空间或显式调高，并在 ADR-10 记一行来历。
// 每一轮的预算沿革与归因见 docs/adr/ADR-10-core-line-budget.md —— 本文件不复述历史。

/** `src/core/` 行数硬上限（官方口径）。 */
export const CORE_MAX_LINES = 4896;

/** 上一轮的上限，只用于报告里说明"从多少改到多少"。 */
export const CORE_MAX_LINES_PREVIOUS = 4889;

/**
 * `src/core/` **字节**硬上限。
 *
 * 为什么行数不够：官方口径是 `split('\n').length`，**只数换行符**。
 * 删掉 50 行空行、换进 50 行超长代码，行数一行不变而体积可以翻倍。
 * 行数管「结构有多大」，字节管「每行里塞了多少东西」。两个都要管，缺一个就有一个形状的绕过。
 */
export const CORE_MAX_BYTES = 261345;

/**
 * **核心源码内容指纹**（仓库级锚）：逐文件 sha256。任何字节变化都会与实测不符。
 *
 * 它不是"内容不许变"的封印 —— 改了核心就该更新它，但那必须是
 * `node scripts/core-manifest.js --write` 后被 review 看见的动作（与行数棘轮同一口径）。
 */
export const CORE_FILE_SHA256 = {
  'core.js': 'ba97fd6a975ab87044c02c5f4f2fc8e29bb50448295dacbb171c620de96b2c83',
  'dependency-resolver.js': 'b2bfd6fd9ee07f36f63a42d61d099a25d576f6457e192c4caaa4b6b29986c778',
  'env.js': '7da8d366aff871dcab754745da5c5f696cc90272068554fd7651aff8615d8098',
  'json5-loader.js': '9f6acbfd13569d93cf18babf982b64d2860a51d586d8e21cc21b7bcd9ac9ac04',
  'lifecycle-manager.js': '721e69ab6d9b4ba30d2cd923e8ded9c77ef5b572d14ea41c5be240b41da802d1',
  'plugin-manager.js': 'eca8aa91f8b1c1648d7ba63d362a609f3d587419fb45bb7fb018cb6aba16ffb3',
  'plugin-meta.js': '365708f7d12a94980f92fedc9d3b30dcb80ca894b3e482bd73bd85ba49d78454',
  'scene-controller.js': 'fba0c37b05c9b3fe65dae28c288c1607de47406b7f38381ddf3074b604da6c4e',
};

/**
 * 三个"道人"模块的**单模块棘轮**：预算 = 当时实测值。
 * 合计**推导**自本表，不得另写字面量（否则两个必须一致的数各自维护，迟早打架）。
 */
export const MODULE_BUDGET = {
  'lifecycle-manager.js': 577,
  'scene-controller.js': 460,
  'dependency-resolver.js': 417,
};

/** 三个道人模块的合计上限（推导值）。 */
export const MODULE_BUDGET_TOTAL = Object.values(MODULE_BUDGET)
  .reduce((a, b) => a + b, 0);

/** `src/` 核心运行时依赖上限。 */
export const CORE_MAX_DEPS = 3;

/** 核心运行时安装体积上限（MB，不含插件与分析层依赖）。 */
export const CORE_MAX_SIZE_MB = 5;
