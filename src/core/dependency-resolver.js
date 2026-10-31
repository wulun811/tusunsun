/**
 * SemVer 受支持子集：精确 / `=` / `^` / `~` / `>` `>=` `<` `<=`。两条不能退让的判据：
 * ① 解析失败一律 false —— "看不懂"不能当成"满足"，否则版本冲突会被伪装成通过；
 * ② `^` 对 `0.x` 必须锁 minor（`^0.2.0` 不接受 `0.3.0`）。
 * "解析不了"与"确实不满足"由 `semverParseError` 分开表达。
 */
const SEMVER_RE = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\s*$/;
const RANGE_RE = /^\s*([><]=?|[=~^])\s*(.+)$|^\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/;

function parseVersion(v) {
  const m = String(v ?? '').match(SEMVER_RE);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null } : null;
}

/** 预发布比较：有 pre 的版本 < 同号无 pre 版本（semver §11 的最小可用子集）。 */
function cmpVersion(a, b) {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d !== 0) return d < 0 ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0;
}

/** `^` 的语义：major>0 锁 major；major===0 锁 minor。 */
function caretUpper(v) {
  if (v.major > 0) return { major: v.major + 1, minor: 0, patch: 0, pre: null };
  if (v.minor > 0) return { major: 0, minor: v.minor + 1, patch: 0, pre: null };
  return { major: 0, minor: 0, patch: v.patch + 1, pre: null };
}

function semverSatisfies(version, rangeStr) {
  const v = parseVersion(version);
  if (!v) return false;                        // 解析失败 = 不满足，绝不放过
  const raw = String(rangeStr ?? '').trim();
  if (raw === '*' || raw.toLowerCase() === 'x') return true;   // 只有显式通配才放行

  const m = raw.match(RANGE_RE);
  if (!m) return false;                        // 空范围/认不出的写法一律 false

  // 裸版本 = 默认 caret（`1.0.0` 等价 `^1.0.0`）；这是被既有测试锁定的对外语义。
  const op = m[1] || '^';
  const r = parseVersion(m[2] || m[3]);
  if (!r) return false;
  // 预发布：带 pre 的版本只有范围也写了 pre 才参与匹配 —— 否则 `2.0.0-rc.1` 会落进
  // `^1.0.0`（数学上确实 < 2.0.0），那不是使用方期望的"兼容"。
  if (v.pre && !r.pre) return false;

  const c = cmpVersion(v, r);
  switch (op) {
    case '^': return c >= 0 && cmpVersion(v, caretUpper(r)) < 0;   // ④ 0.x 锁 minor
    case '~': return c >= 0 && v.major === r.major && v.minor === r.minor;
    case '>=': return c >= 0;
    case '>': return c > 0;
    case '<=': return c <= 0;
    case '<': return c < 0;
    case '=': return c === 0;
    default: return false;
  }
}

/** `provides` 的两种写法（字符串 / 对象）归一成对象数组。 */
const providesOf = (p) => (Array.isArray(p.provides) ? p.provides : [])
  .map((x) => (typeof x === 'string' ? { name: x } : x))
  .filter((x) => x && typeof x.name === 'string');

/**
 * 服务名 → 提供者插件。`requires` / `optional` 的键**插件名优先**，其次服务名；这是依赖边
 * 的**唯一解释位置**（启动排序、停机排序、懒加载闭包、卸载闸门都从这里取 —— 各写一套就会
 * 出现"启动有序、停机反序、卸载放行"）。
 *
 * `serviceOwners` 是**运行时归属**：传了就以它为准（声明只是承诺，归属才是事实），且只采纳
 * **当前已装载**的 owner —— 已卸载的插件不能继续充当提供者。
 */
function providerIndexOf(plugins, serviceOwners = null) {
  const names = new Set(plugins.map((p) => p.name));
  const providerOfService = new Map();
  for (const p of plugins) {
    for (const pr of providesOf(p)) {
      if (!providerOfService.has(pr.name)) providerOfService.set(pr.name, p.name);
    }
  }
  if (serviceOwners && typeof serviceOwners[Symbol.iterator] === 'function') {
    for (const [svc, owner] of serviceOwners) {
      if (names.has(owner)) providerOfService.set(svc, owner);
    }
  }
  return providerOfService;
}

/** 键 → 提供者插件名。认不出返回 null：是硬失败还是放行，由调用方按场景决定。 */
function resolveDependencyTarget(depName, byName, providerOfService) {
  if (byName.has(depName)) return depName;
  return providerOfService.get(depName) || null;
}

/**
 * 谁**硬依赖** `targetName`（`requires` 键按同一份解释解析成提供者，命中才算）。`optional`
 * 不计入 —— 拿它阻止卸载就是把可选当必需。返回 `[{ plugin, dep }]`，`dep` 是声明里写的键。
 */
export function dependentsOf(targetName, plugins, serviceOwners = null) {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const providerOfService = providerIndexOf(plugins, serviceOwners);
  const out = [];
  for (const p of plugins) {
    if (p.name === targetName) continue;
    for (const depName of Object.keys(p.requires || {})) {
      if (resolveDependencyTarget(depName, byName, providerOfService) === targetName) {
        out.push({ plugin: p.name, dep: depName });
      }
    }
  }
  return out;
}

/**
 * 在**待装载集合**里把依赖键解析成插件名（插件名优先，其次服务名）。
 * `null` = 待装载集合里没有它的提供者（可能已装载，也可能真缺席）。
 */
export function resolvePendingDependency(depName, pending) {
  const entries = [];
  for (const [name, e] of pending) entries.push({ name, provides: e?.provides });
  const byName = new Map(entries.map((e) => [e.name, e]));
  return resolveDependencyTarget(depName, byName, providerIndexOf(entries));
}

class DependencyResolver {
  constructor(core) {
    this.core = core;
  }

  buildDAG(plugins) {
    const map = new Map();
    const inDegree = new Map();
    const edges = [];

    for (const p of plugins) {
      map.set(p.name, p);
      inDegree.set(p.name, 0);
    }

    // 认不出的名字仍然是硬失败，版本不满足仍然报错 —— 不静默放行。
    // 解释规则只有一份（`resolveDependencyTarget`）：这里若自己只查插件名，
    // `requires: { 'tool-registry': ... }` 就会让 DAG 必定失败并回退目录顺序。
    const providerOfService = providerIndexOf(plugins);

    for (const p of plugins) {
      const deps = p.requires || {};
      const optional = p.optional || {};
      for (const [depName, range] of Object.entries(deps)) {
        const target = resolveDependencyTarget(depName, map, providerOfService);
        if (!target) {
          return { ok: false, error: `Plugin "${p.name}" requires "${depName}" which is not available` };
        }
        // 版本判据的分母：服务项声明了 api_version 就用它（与准入闸门同口径），
        // 否则用提供方插件的版本。
        const svc = target === depName ? null : providesOf(map.get(target)).find((x) => x.name === depName);
        const depVersion = (svc && svc.api_version) || map.get(target).version || '0.0.0';
        if (!semverSatisfies(depVersion, range)) {
          return { ok: false, error: `Version mismatch: "${depName}" ${depVersion} does not satisfy "${range}" required by "${p.name}"` };
        }
        // 自依赖（插件 require 自己提供的服务）不建边：那不是环，只是冗余声明。
        if (target === p.name) continue;
        edges.push([target, p.name]);
        inDegree.set(p.name, (inDegree.get(p.name) || 0) + 1);
      }
      for (const [depName] of Object.entries(optional)) {
        const target = resolveDependencyTarget(depName, map, providerOfService);
        if (target && target !== p.name) {
          edges.push([target, p.name]);
          inDegree.set(p.name, (inDegree.get(p.name) || 0) + 1);
        } else if (!target) {
          this.core.log('warn', `Optional dependency "${depName}" missing for "${p.name}"`);
        }
      }
    }

    return { ok: true, map, inDegree, edges };
  }

  topologicalSort(plugins) {
    const dag = this.buildDAG(plugins);
    if (!dag.ok) return dag;

    const { inDegree, edges } = dag;
    const queue = [];
    const result = [];
    const adj = new Map();

    for (const [from, to] of edges) {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push(to);
    }

    for (const [name, deg] of inDegree) {
      if (deg === 0) queue.push(name);
    }

    while (queue.length > 0) {
      const node = queue.shift();
      result.push(node);
      for (const neighbor of (adj.get(node) || [])) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) queue.push(neighbor);
      }
    }

    if (result.length !== plugins.length) {
      const cycle = this._findCycle(plugins, edges);
      if (cycle) return { ok: false, error: `Circular dependency detected: ${cycle.join(' → ')}` };
      // 排不出序却找不到环：典型成因是输入里有同名插件（inDegree 以 name 为键去重，
      // 节点数 < 输入数）。必须如实报告成因，不能渲染成"环"——那会把排查引向错误方向。
      // 错误串里带插件名，`resolveWithFallback` 的按名匹配才生效。
      const names = plugins.map((p) => p.name);
      const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      const stuck = [...inDegree.entries()].filter(([, deg]) => deg > 0).map(([name]) => name);
      const detail = dupes.length
        ? `duplicate plugin names: ${dupes.join(', ')}`
        : `unresolved nodes: ${stuck.join(', ') || 'none'}`;
      return { ok: false, error: `Dependency graph not orderable (no cycle found; ${detail})` };
    }

    return { ok: true, order: result, map: dag.map };
  }

  async resolveWithFallback(plugins, fallback = {}) {
    const result = await this.topologicalSort(plugins);
    if (result.ok) return result;

    const missingOrFailed = new Set();
    const originalError = result.error;

    for (const [name, fallbackName] of Object.entries(fallback)) {
      if (result.error.includes(name)) {
        this.core.log('warn', `Fallback: "${name}" → "${fallbackName}"`);
        this.core.emit('scene.fallback', {
          from: name,
          to: fallbackName,
          timestamp: new Date().toISOString(),
          sourcePlugin: 'dependency-resolver',
        });
        const fbPlugin = plugins.find(p => p.name === fallbackName);
        if (fbPlugin) {
          missingOrFailed.add(name);
        }
      }
    }

    const filtered = plugins.filter(p => !missingOrFailed.has(p.name));
    if (filtered.length < plugins.length) {
      return this.topologicalSort(filtered);
    }
    return { ok: false, error: originalError };
  }

  resolveLazyChain(pluginName, pending) {
    // 闭包递归用**同一份**依赖解释：`requires` 的键可能是插件名，也可能是服务名。
    // 只查 `pending.get(depName)` 时，`requires:{'db-service':…}` 的提供者永远进不了闭包，
    // 依赖方会被单独装载然后在 init 里报缺服务。
    const entries = [];
    for (const [name, e] of pending) {
      entries.push({ name, provides: e?.provides, requires: e?.requires, version: e?.version });
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const providerOfService = providerIndexOf(entries);
    const inChain = new Map();
    const unresolved = [];
    const walk = (name) => {
      if (inChain.has(name)) return;
      const entry = byName.get(name);
      if (!entry) return;
      inChain.set(name, entry);
      for (const depName of Object.keys(entry.requires || {})) {
        const target = resolveDependencyTarget(depName, byName, providerOfService);
        if (!target) unresolved.push({ plugin: name, dep: depName });
        else if (target !== name) walk(target);
      }
    };
    walk(pluginName);
    if (inChain.size === 0) {
      return { ok: false, error: `"${pluginName}" not in pending` };
    }
    const plugins = [];
    for (const [name, entry] of inChain) {
      const requires = {};
      for (const depName of Object.keys(entry.requires || {})) {
        const target = resolveDependencyTarget(depName, byName, providerOfService);
        // 保留**原始键**：服务名的版本要对提供者的 api_version 比对，不能换成插件名后重算。
        if (target && inChain.has(target)) requires[depName] = entry.requires[depName];
      }
      plugins.push({ name, version: entry.version, provides: entry.provides, requires, optional: {} });
    }
    const sorted = this.topologicalSort(plugins);
    return { ...sorted, unresolved };
  }

  _findCycle(plugins, edges) {
    const adj = new Map();
    for (const [from, to] of edges) { if (!adj.has(from)) adj.set(from, []); adj.get(from).push(to); }
    const visited = new Set(), stack = [];
    const dfs = (node) => {
      if (stack.includes(node)) return [...stack.slice(stack.indexOf(node)), node];
      if (visited.has(node)) return null;
      visited.add(node); stack.push(node);
      for (const n of (adj.get(node) || [])) { const c = dfs(n); if (c) return c; }
      stack.pop(); return null;
    };
    for (const p of plugins) { const c = dfs(p.name); if (c) return c; }
    // 找不到环就返回 null，由调用方给出"排不出序但不是环"的诚实诊断（不得渲染成环）。
    return null;
  }
}

/**
 * 强连通分量（Tarjan，迭代版）：`edges` 是 `n → [它**硬**依赖的节点]`。
 *
 * 停机时「环内互等」可作**有损例外**豁免（见 `Core._pendingDependentsOf`），但判据必须是
 * 「同一个 SCC」而不是「出现在任意一个环里」—— 后者会把两个互不相干的环之间那条**真实**
 * 依赖边一起豁免：`c→a` 跨环时 `c.stop()` 超时后 `a` 照样被停，而 `c` 还在用它的服务。
 */
function componentsOf(edges) {
  const idx = new Map(), low = new Map(), stack = [], on = new Set(), comp = new Map();
  let seq = 0, id = 0;
  for (const root of edges.keys()) {
    if (idx.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const n = frame[0];
      if (frame[1] === 0) { idx.set(n, seq); low.set(n, seq); seq++; stack.push(n); on.add(n); }
      const outs = edges.get(n) || [];
      if (frame[1] < outs.length) {
        const m = outs[frame[1]++];
        if (!idx.has(m)) { work.push([m, 0]); continue; }
        if (on.has(m)) low.set(n, Math.min(low.get(n), idx.get(m)));
        continue;
      }
      work.pop();
      if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(n))); }
      if (low.get(n) === idx.get(n)) {
        let m;
        do { m = stack.pop(); on.delete(m); comp.set(m, id); } while (m !== n);
        id++;
      }
    }
  }
  return comp;
}

/**
 * 停机顺序：**依赖方先停，提供方后停**（= 启动拓扑序的反向）。不能直接反转
 * `topologicalSort()` 的结果：① 停机只面对**已装载**的插件，提供者缺席只是少一条边；
 * ② 版本不满足在停机时不是障碍（已经装进来了）；③ 环必须仍给出顺序（否则关机挂住），
 * 但不能隐瞒。故恒返回一个顺序，并如实交出 `basis` / `unresolved` / `cycles`。
 */
export function computeStopOrder(plugins, serviceOwners = null) {
  const byName = new Map(plugins.map((p) => [p.name, p]));
  // 运行时归属优先于 `provides` 声明：声明是承诺，归属是事实。
  // rc.6 的调用方（`Core._stopOrder`）一直传 `_serviceOwners`，而这里当时**没有形参** ——
  // 注释写着"归属优先"，代码只认声明。启动/卸载/懒加载三处都认归属，只有停机排序不认，
  // 正是"四个消费者共用一份解释"没真共用的锥形。
  const providerOfService = providerIndexOf(plugins, serviceOwners);
  const unresolved = [];
  const deps = new Map();   // 排序用：requires + optional（可选依赖也决定谁先停）
  const hard = new Map();   // SCC 用：**只** requires —— 豁免只能落在真正互相挡住的那条关系上
  for (const n of byName.keys()) {
    const p = byName.get(n);
    const targets = [];
    const add = (depName) => {
      const target = resolveDependencyTarget(depName, byName, providerOfService);
      // 缺席的提供者不建边（停机不能因为"它不在"就排不出序），但必须交出去。
      if (!target) { unresolved.push({ plugin: n, dep: depName }); return; }
      // 自依赖（插件 require 自己提供的服务）不是边：那不是环，只是冗余声明。
      if (target !== n && !targets.includes(target)) targets.push(target);
    };
    for (const depName of Object.keys(p?.requires || {})) add(depName);
    hard.set(n, [...targets]);
    for (const depName of Object.keys(p?.optional || {})) add(depName);
    deps.set(n, targets);
  }
  // 有边才叫"按关系排"；没有边时这只能是插入序，调用方必须能分辨。
  const basis = [...deps.values()].some((d) => d.length) ? 'dependency' : 'insertion';
  const order = [];
  const state = new Map();   // 1 = 在栈上，2 = 已完成
  const cycles = [];
  const visit = (n, stack) => {
    const s = state.get(n);
    if (s === 2) return;
    if (s === 1) {
      // 回到栈上的节点：记下环并停止递归 —— 停机必须出顺序，不能挂在这里。
      const path = stack.slice(stack.indexOf(n)).concat(n).join(' → ');
      if (!cycles.includes(path)) cycles.push(path);
      return;
    }
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) || []) visit(d, stack);
    stack.pop();
    state.set(n, 2);
    order.push(n);
  };
  for (const n of byName.keys()) visit(n, []);
  order.reverse();
  const seen = new Set();
  const unresolvedUnique = unresolved.filter((u) => {
    const k = `${u.plugin} <- ${u.dep}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // `components` = 每个插件在**硬依赖图**上的 SCC 编号。停机豁免用它，不要自己再猜环。
  return { order, basis, unresolved: unresolvedUnique, cycles, components: componentsOf(hard) };
}

export { DependencyResolver, semverSatisfies };
export default DependencyResolver;
