# ADR-06：依赖版本判据从"宽松"改为"严格受支持子集"

- 状态：**已采纳**（v0.12.0，K-11）
- 影响面：`src/core/dependency-resolver.js`（`semverSatisfies` 及其辅助函数）
- 关联：K-11、I-02

## 1. 要决定的问题

修前的 `semverSatisfies` 有三处不诚实，其中第一处最危险：

```js
const m = (version || '').trim().match(/^\s*v?(\d+)\.(\d+)\.(\d+)/);
const r = (rangeStr || '').trim().match(/^([><]=?|[=~^]?)\s*v?(\d+)\.(\d+)\.(\d+)/i);
if (!m || !r) return true;        // ← 解析失败 = 满足
```

实测（K-11）：

```
0.3.0  vs "^0.2.0"     → true   （应该 false：^0.x 必须锁 minor）
1.0.0  vs "abc"        → true   （应该 false）
1.0.0  vs ">=garbage"  → true   （应该 false）
nonsense vs "^1.0.0"   → true   （应该 false）
```

**一个写错版本号的插件会被判定"依赖满足"，然后带着不兼容的依赖被装进系统。**
而且这个"绿"是静默的 —— 没有任何日志说"我没看懂你的版本约束"。

第二处：`^` 的语义对 `0.x` 是错的（`0.3.0` 满足 `^0.2.0`），与 semver 规范相反。

## 2. 两个候选

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A | 引入 `semver` npm 包 | 完整、正确 | **违反零运行时依赖承诺**（这是本项目的硬约束） |
| B | 实现"小而严格的受支持子集"，解析失败一律 false | 零依赖、行为可枚举、错得明白 | 不支持的写法会被拒（但会**说出来**，不再静默放行） |

## 3. 决定

**选 B。** 受支持子集：

- 精确版本 / `=` / `^` / `~` / `>` `>=` `<` `<=` / 显式通配 `*` 或 `x`
- `^` 的正确语义：`major>0` 锁 major；`major===0 && minor>0` 锁 minor；`0.0.x` 锁 patch
- 预发布：带 `-pre` 的版本**只有**范围本身也写 `pre` 时才参与匹配
- 裸版本（无操作符）= **默认 caret**（`1.0.0` ≡ `^1.0.0`）—— 这条是本仓既有语义，
  被既有测试锁定，**不属于本轮要改的缺陷**，保留

**解析失败一律返回 `false`。** 不再有"看不懂就放行"。

## 4. 兼容性核对（做完了才敢收紧）

用 `extractPluginMetaFromFile` 扫了仓内全部 12 个真实插件的 `requires`：

```
agent          model              >=0.3.0
cell-context   cell-runtime       >=0.1.0
chat-ui        gateway            >=0.3.0
compaction     cell-context       >=0.1.0
context-manager session           >=0.3.0
context-port   cell-context       >=0.1.0
experience-port cell-context      >=0.1.0
haotian-lite   session            >=0.3.0
plugin-context prompt             >=0.5.0
prompt-builder prompt-template    >=0.4.0, tool-normalizer >=0.4.0
tool-executor  tool-registry      >=0.4.0, tool-guard >=0.4.0
tool-guard     tool-registry      >=0.4.0
```

**全部是 `>=x.y.z` 形态，没有一个用 `^` 或非法串。** 所以收紧不会破坏现有装配。
这条核对本身也进了回归锁（`K-11/3`），以后再有人改 `requires` 写法会被提醒。

## 5. 被改写的两条既有测试

| 测试 | 原断言 | 现断言 |
|---|---|---|
| `dependency-resolver-advanced.test.mjs` | `'Semver: invalid versions pass (lenient)'` —— 明确要求非法输入放行 | 非法输入**不得**满足（并注明"旧行为是缺陷"） |
| `dependency-resolver-edge.test.mjs` | `'both invalid returns true'` | 无法解析一律不满足 |

按落地计划 P0 的要求："不直接把旧测试删掉冒充升级"。
两处都保留了原测试的**语义位置**，只把判据改到正确的那一侧，并在注释里记录了变更理由。

## 6. 判据与变异

| 断言 | 位置 |
|---|---|
| 四种非法输入一律 false | `K-11/1` |
| `^0.2.0` 接受 `0.2.5`、拒绝 `0.3.0`；`^0.0.3` 接受 `0.0.3`、拒绝 `0.0.9` | `K-11/2` |
| 仓内全部真实 `requires` 可解析 | `K-11/3` |

变异验证：把 `if (!v) return false` 改回 `return true` ⇒ `K-11/1` 变红。

## 7. 仍然不支持（明确列出，不假装完整）

- 范围联合（`||`）
- 连字符范围（`1.2.3 - 2.3.4`）
- `x` 作为段位通配（`1.x`、`1.2.x`）
- 元数据（`+build`）

这些写法现在会被**明确拒绝**，而不是被误判为满足。
若将来真有插件需要，应在 ADR 里逐个加，而不是放宽"解析失败"这条底线。
