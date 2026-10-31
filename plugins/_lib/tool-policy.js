// tool-policy.js — 「哪些工具是只读的」的**单一真相**。
//
// v0.9.24 建立。此前这份名单被**复制成两份**：
//   · `plugins/cell-runtime.js`   `READONLY_TOOLS`（Cell 的 permission_mode 门，14 项）
//   · `src/builtin/tool-executor.js` `_checkModeReadOnly` 的 `readTools`（14 项）
// 两处逐字相同，且 cell-runtime 的注释明写「与执行器同一套名单口径」——
// 但**没有任何机制保证**它明天仍然相同。这与 v0.9.23 查出的"三套 token 估算"是同一个形状：
// 注释声称同源，实际各写一份。
//
// 分叉的后果是**双向的**，而且都是安全问题：
//   · 只在执行器里新增 → Cell 的 read-only Cell 会**拒掉一个本该放行的只读工具**（可用性）；
//   · 只在 cell-runtime 里新增 → 执行器会**放行一个本该拦截的写工具**（越权）。
// 后者更糟：它把"只读"这个声明变成了一句空话。
//
// 为什么落在 `plugins/_lib/`（v0.9.25 起）：
//   v0.9.24 时它在 `src/builtin/`，理由是"依赖方向单向"——`plugins/` 有十余处
//   `import ../src/...`，把名单放 `plugins/` 会逼执行器反向引用，在**目录级**制造环。
//   那条理由成立，但它是**目录分裂的产物**：`src/builtin/` 与 `plugins/` 只是存放位置不同，
//   运行时同一个 PluginManager 装载，所以"两个目录"本身没有承载任何语义，
//   却凭空造出了一个需要论证的依赖方向。合并后环的问题**连同它的论证一起消失**。
//   现在它放在 `_lib/`，理由是另一件、也是唯一一件仍然成立的事：
//   它**不是插件**（没有 name/init，不被装载），只是个被 import 的判据模块。
//   `plugins/` 一级的语义因此是干净的：一级 .js = 插件，`_lib` = 内部模块。
//
// 为什么用 `Object.freeze` 的 Set 语义而不是数组：
//   调用方都在做 `has()` 判定（O(1)），且**不允许**任何人往里面 push。
//   Set 本身没有 frozen 语义，所以对外只暴露判据函数，不暴露集合本体。

const READONLY_TOOL_NAMES = [
  // 纯读：读文件/列目录/取元信息
  'tool-read', 'tool-list', 'tool-stat',
  // 读但不写：检索、比对、解析、校验
  'tool-grep', 'tool-glob', 'tool-json', 'tool-diff', 'tool-search',
  // 只读的会话内状态：待办与备注不碰工作区文件
  'tool-todo', 'tool-note',
  // 检查类：validate 只报告不改写；context 只读上下文；db 默认只读查询
  'tool-validate', 'tool-context', 'tool-db',
  // R3-01（v0.16.0-rc）：受控多文件事务的**只读两半**。
  // 不登记的后果与前几次同形：只读 Cell 能读锁、却不能“先计划再提交”，
  // 提示词让它先计划，而计划工具被 `permission_denied` 拒 —— 只能盲写。
  // `tool-txn-commit` **不在此列**：它写盘。
  'tool-txn-plan', 'tool-txn-status',
  // 兼容外部的下划线命名
  'read_file',
];

const READONLY_TOOLS = new Set(READONLY_TOOL_NAMES);

/**
 * 某工具名是否只读。
 *
 * 注意：这是**工具名**判定，不是能力 id 判定。`tool-read` 是工具名，
 * `tool.read` 是能力 id（`capabilityIdFor` 做这个转换）。
 */
export function isReadonlyTool(toolName) {
  return READONLY_TOOLS.has(toolName);
}

// ── R0-131/A（v0.9.30）：**能力 id → 只读** ───────────────────────────────
//
// 为什么必须补这一条：`isReadonlyTool` 判的是**工具名**，而执行器最终调用的目标是
// **能力**。两者的对应关系在默认装配里是"`tool-read` ↔ `tool.read`"这种一望即知的派生，
// 但那个派生关系**不是强制的**：`ToolExecutor._capabilityIdsForTool` 认三条来源
// （命名约定 / 工具自报的 `provides[]` / 按 `owner` 反查），而 `cell-runtime` 的
// `capIdOf` 只认第一条。于是"一个名字里带 read 的工具"可以 `provides: tool.write`，
// 安全门按名字放行、执行器按 provides 真写盘 —— 专家 R0-131/A 的实测反例。
//
// 这里给出名字无关的判据：**能力 id 决定效果类别**。规则刻意取保守方向：
//   · 非 `tool.*` 的前缀一律不是只读工具能力（认知/模型能力不归本条管）；
//   · `tool.<x>` 里 `<x>` 必须逐字出现在只读清单对应的能力名里
//     （清单里 `tool-read` = 能力 `tool.read`；`read_file` 这类下划线工具名没有对应能力，
//     它对宿主自报的能力名不构成授权依据）。
// 换句话说：**不认识的，就不是只读的**。默认拒绝，白名单放行。
const READONLY_CAPABILITY_IDS = new Set([
  ...READONLY_TOOL_NAMES
    .filter((n) => n.startsWith('tool-'))
    .map((n) => `tool.${n.slice('tool-'.length)}`),
  // AR-C04（v0.11.0）：**不派生于工具名**的能力，必须在这里显式登记。
  //
  // `action.inspect` 读的是执行器内存里的回执留档（`_receipts`）+ 一次 stat，
  // 不写盘、不改状态，效果类别就是只读。它此前**没被登记**，于是：
  //   · `permission_mode: read-only` 的 Cell 调它会拿到 permission_denied；
  //   · `_dispatchGuard` 也按"非只读"拒绝。
  // 而工具输出里每一条回执都在提示模型"（明细：action.inspect <id>）"——
  // 提示了一个只读 Cell 永远调不动的动作。这一行就是那个缺口的补丁。
  'action.inspect',
  // R0-163（六合 Lite 接线）：Lite 的两个**只读**动作。
  //
  // 与 `action.inspect` 是同类缺口，但成因不同：那两个是"名字派生不出来、host 侧漏登记"，
  // 这两个是"Provider 的只读动作，宿主没见过所以默认不放行"。
  // `read_anchor` 读一次 stat + 一次 readFile 算 hash；`inspect` 读日记与当前盘上 hash。
  // 都不写盘、不改状态，效果类别就是只读。
  //
  // 不登记的后果与 `action.inspect` 那次一模一样：`permission_mode: 'read-only'` 的 Cell
  // 调 `tool-liuhe-anchor` 会被 `permission_denied` 拒，而提示词正在告诉模型
  // "改文件前先取锚点" —— 那条建议永远兑不了，只读 Cell 只能盲写。
  //
  // `liuhe.apply` / `liuhe.undo` / `liuhe.preview` **刻意不在此列**：前两个改盘；
  // `preview` 虽不写盘但会读全文算 hash，保守方向按非只读处理。
  // 未登记的默认就是"不是只读"，那条默认值不因为"它大概不改东西"而破例。
  'liuhe.read_anchor',
  'liuhe.inspect',
]);

/**
 * 某**能力 id** 是否属于只读效果类别。未登记的能力 id 一律返回 false（默认非只读）。
 *
 * 注意它回答的是"效果类别"，**不是**"这个调用方有没有资格"，也**不是**"结果能不能缓存"
 * —— 后两者各有各的判据（`_assertCapabilityAllowed` / `isCacheableCapability`）。
 */
export function isReadonlyCapability(capId) {
  return READONLY_CAPABILITY_IDS.has(capId);
}

// ── AR-C04（v0.11.0）：模型可直接点名的能力 ────────────────────────────────
//
// 背景：执行器把"请求名 → 能力 id"的解析写成了三条来源（命名约定 `tool-<x>` → `tool.<x>`、
// 工具自报 `provides[]`、按 `owner` 反查）。这三条**都要求调用方先有一个工具对象**。
// 而 `action.inspect` 是执行器**自己**注册的能力，没有对应工具、owner 是 `tool-executor`，
// 于是三条全落空 → 解析出 `capId = null` → 掉进 legacy 直连 → 被 R0-81 拒绝。
//
// 实测（真 Core + 真 tool-executor，v0.10.4）：
//   `executeOne('action.inspect', {action_id})` → `capability_denied`
//   `core.callCapability('action.inspect', …)`  → 能到 handler，但 `currentSession()` 为 null
//   ⇒ `receipt_scope_missing`
// 也就是说：工具输出里那句"明细：action.inspect xxx"**是一条永远兑不了的承诺**。
//
// 修法取**白名单**而不是"任何已注册能力都可点名"：后者会把执行器的能力表整体
// 变成模型可调面（`cell.spawn`、`tool.compose` 之类也一并暴露），那是扩大攻击面。
// 只登记真正要给模型用的那几个，新增必须显式加一行 —— 与只读清单同一个原则：
// **不认识的，就不给。**
const MODEL_INVOCABLE_CAPABILITIES = new Set(['action.inspect']);

/** 某能力 id 是否允许模型**直接用能力名**点名调用。未登记一律 false。 */
export function isModelInvocableCapability(capId) {
  return MODEL_INVOCABLE_CAPABILITIES.has(capId);
}

/** 可被模型点名的能力 id 清单（副本）。 */
export function listModelInvocableCapabilities() {
  return [...MODEL_INVOCABLE_CAPABILITIES];
}

// ── 只读 ≠ 可缓存 ────────────────────────────────────────────────────────
//
// 执行器对"只读能力"的结果做了 30s 缓存（R0-132）。但 `action.inspect` 的返回值里
// 有 `current_sha256` / `current_exists` / `current_mtime_ms` / `undo_supported`
// —— 这些是**磁盘此刻的事实**，不是"上次算出来的事实"。
// 把它一并缓存，等于让"查当前真相"的工具回报 30 秒前的真相：
// Cell 刚被外部改过文件，`action.inspect` 仍会说"没变"。那是缓存制造的新谎。
//
// 所以把"效果类别"与"可缓存性"拆成两个判据。默认：只读即可缓存（保持既有行为），
// 只有显式登记的例外不可缓存。
const NON_CACHEABLE_CAPABILITIES = new Set(['action.inspect']);

/** 某能力 id 的结果是否允许进结果缓存。 */
export function isCacheableCapability(capId) {
  return isReadonlyCapability(capId) && !NON_CACHEABLE_CAPABILITIES.has(capId);
}

/** 只读能力 id 清单（副本，调用方改它不影响判据）。 */
export function listReadonlyCapabilities() {
  return [...READONLY_CAPABILITY_IDS];
}

/** 只读工具名清单（副本，调用方改它不影响判据）。 */
export function listReadonlyTools() {
  return [...READONLY_TOOL_NAMES];
}

/** 只读工具名的 Set 副本（供需要 `has()` 且要长期持有的调用方）。 */
export function readonlyToolSet() {
  return new Set(READONLY_TOOL_NAMES);
}
