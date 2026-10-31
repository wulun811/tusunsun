class ToolGuard {
  name = 'tool-guard';
  version = '0.4.0';
  // R0-112 缺陷 2：tool-loader 提供/注册的服务名是 `tool.registry`（运行期 registerService
  // 用的是 `tool-registry`），不是插件名 `tool-loader`。写成插件名 ⇒ 该服务永不存在，
  // 默认场景每次启动都报一条假违例。
  requires = { 'tool-registry': '>=0.4.0' };
  permissions = [];
  // R0-156：同 tool-loader —— 声明名必须等于 registerService 的实际注册名
  // （此前写 `tool.guard`，而注册的是 `tool-guard`，于是 require 的那一方拿到假绿灯）。
  provides = [{ name: 'tool-guard', type: 'service', removable: false }];

  async init(core) {
    this.core = core;
    this._allowlist = core.get('tools.allowlist') || [];
    this._blocklist = core.get('tools.blocklist') || [];
    this._maxResultSize = core.get('tools.maxResultSize') || 10000;
    core.registerService('tool-guard', this);
  }

  /**
   * 这个工具**请求名**是否被允许。
   *
   * R0-142（v0.9.31 续）：这是**第一层**过滤，判据是请求名，因此它**不能**单独承担授权。
   *
   * 实测绕过：`tools.allowlist=['safe-wrapper']`，请求 `safe-wrapper`，
   * 而该工具 `provides: [{name:'tool.write'}]` —— 本函数按名字放行，执行器随后
   * 按 provides 落到 `tool.write` 能力上，**真的写盘**、返回 `succeeded`。
   * 这与 R0-131/A 是同一个形状（判据按名字派生），只是入口在 allowlist。
   *
   * 现在两层各司其职：
   *   · 本函数：**名字**是否在允许集合内（用于"连请求都不该出现"的粗过滤、早退）；
   *   · 执行器派发期：**解析出的能力**是否被授权（`_dispatchGuard` + Cell 门）。
   * 后者才是授权。这里**不**假装自己按能力判 —— 它拿不到能力 id，也不该去猜。
   */
  allow(toolName) {
    if (this._blocklist.includes(toolName)) {
      this.core.emit('tool.blocked', {
        tool: toolName, reason: 'blocklist',
        timestamp: new Date().toISOString(), sourcePlugin: 'tool-guard',
      });
      return false;
    }
    if (this._allowlist.length && !this._allowlist.includes(toolName)) {
      this.core.emit('tool.blocked', {
        tool: toolName, reason: 'not_in_allowlist',
        timestamp: new Date().toISOString(), sourcePlugin: 'tool-guard',
      });
      return false;
    }
    return true;
  }

  /**
   * R0-142：按**解析出的能力 id** 的允许判据（供执行器在派发期调用）。
   *
   * 为什么必须单独有一个：上面的 `allow()` 判请求名，别名 / `provides` / owner 反查
   * 都能让"名字安全"的工具落到"能力危险"的目标上。授权必须以真实目标为准 ——
   * 这是 R0-131 以来本项目始终贯穿的那句话。
   *
   * 语义取保守方向（与 R0-131/A 的 `isReadonlyCapability` 同样口径）：
   *   · 未配置 allowlist ⇒ 不干预（返回 true）；
   *   · 配了 allowlist    ⇒ 能力 id 必须**逐字**在名单里，或它在名单里某个工具名派生出的
   *     能力集合内（`tool-read` 与 `tool.read` 是同一样东西的两种写法，不能让用户
   *     为了兼容写法而把两个都写进去）。
   *   · 能力 id 为空（目标不明）⇒ **拒绝**。不明不等于安全。
   */
  allowCapability(capId) {
    // M1：**blocklist 是能力侧的否决**，与 allowlist 不是同一个集合的两半。
    // 修前它只在 `allow()` 里按请求名判，于是一个别名工具可以绕过它：
    // `blocklist: ['tool-bash']` 时 `allow('shell-alias') === true`、
    // `allowCapability('tool.bash') === true` —— 名字挡得住，能力挡不住。
    if (this._blocklist.length) {
      const id = capId == null ? null : String(capId);
      const hit = id != null && this._blocklist.some((entry) => sameToolAndCapability(String(entry), id));
      if (id == null || hit) {
        this.core.emit('tool.blocked', {
          tool: null, capability: id,
          reason: id == null ? 'capability_unresolved' : 'capability_in_blocklist',
          timestamp: new Date().toISOString(), sourcePlugin: 'tool-guard',
        });
        return false;
      }
    }
    if (!this._allowlist.length) return true;
    if (capId == null) {
      this.core.emit('tool.blocked', {
        tool: null, capability: null, reason: 'capability_unresolved',
        timestamp: new Date().toISOString(), sourcePlugin: 'tool-guard',
      });
      return false;
    }
    const id = String(capId);
    const ok = this._allowlist.some((entry) => sameToolAndCapability(String(entry), id));
    if (!ok) {
      this.core.emit('tool.blocked', {
        tool: null, capability: id, reason: 'capability_not_in_allowlist',
        timestamp: new Date().toISOString(), sourcePlugin: 'tool-guard',
      });
    }
    return ok;
  }

  filter(result) {
    if (typeof result === 'string' && result.length > this._maxResultSize) {
      return result.slice(0, this._maxResultSize) + '\n... (truncated)';
    }
    return result;
  }
}

/**
 * `tool-read` ↔ `tool.read` 的同义判定。**只**认这一条明确派生，不做模糊匹配 ——
 * 模糊匹配会把 `tool.read` 与 `tool.readwrite` 当成一回事（R0-142 踩过）。
 * allowlist 与 blocklist 共用同一份等价关系：写两份就会漂移，而漂移的方向永远是
 * “一边挡得住、一边漏过去”。
 */
function sameToolAndCapability(a, b) {
  if (a === b) return true;
  if (a.startsWith('tool-') && `tool.${a.slice(5)}` === b) return true;
  if (b.startsWith('tool-') && `tool-${b.slice(5)}` === a) return true;
  return false;
}

export default new ToolGuard();
