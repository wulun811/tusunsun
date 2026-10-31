# 能力身份与声明契约 v1

> **这是一份规范，不是一份实现声明。**
> §1–§8 冻结的是**目标不变式**；§9 才是**当前实现状态**，逐条标注
> `IMPLEMENTATION_PASS` / `IMPLEMENTATION_COUNTEREXAMPLE` / `NOT_RUN` 并给出复现指针。
> 不得用前面几章的措辞宣称实现已经达标。

**为什么有这份文件**：`src/core/core.js` 的两条报错文本（`schema_unsupported` 与
`identity_authority_denied`）一直写着「见 contracts/capability-identity-v1.md」，
而该路径在仓库历史上从未存在过（`git log --all -- contracts/` 为空）。
同一句报错把用户指向空处，等于把「可诊断」降级为「报了个错」。本文件补上这个锚点。

**相关文件**

| 文件 | 关系 |
|---|---|
| `docs/adr/ADR-08-capability-and-service-ownership.md` | 历史裁决：归属为什么必须由装配上下文给出 |
| `docs/adr/ADR-02-plugin-owner-and-hot-reload.md` | 热重载与 owner 的兼容边界 |
| `docs/adr/ADR-13-denial-execution-stage.md` | 拒绝发生在派发前还是派发后 |
| `verification/contracts/oss-core-v1.md` | F01–F08 形式化合同；F01 以本文件为规范出处 |

---

## 1. 五个概念不得合并

把其中任意两个压回一个字符串，都会得到一个既能被自报值伪造、又在清理时误删的形状。

| 概念 | 定义 | 由谁决定 | 可否被插件自报 |
|---|---|---|---|
| **Manifest name** | 插件的可读名字与命名空间 | 插件清单 | 是（须过保留名与格式校验） |
| **Provider provenance** | 「这个能力是被哪一笔装配登记进来的」 | **装载器**（受信装配上下文） | **否** |
| **Registration identity** | 某一次成功登记的内部标识，用于精确覆盖与回收 | Core | **否** |
| **Principal** | 宿主授权的调用主体，回答「调用者是谁」 | 宿主引导通道（构造期注入权威） | **否** |
| **Scope** | 有限权限等级值类型 | 宿主 `assertIdentity` 登记值 | 否（调用时的自报值只用于比对） |

`config.owner` 自报值**最多**是描述字段，用于日志与兼容审计。它**不**是授权凭据，
**不**是清理依据，**不**是覆盖判据。

---

## 2. 身份断言（Principal）

- 唯一入口是 `Core#assertIdentity(principal, { caller, scope, issuer })`。
- `issuer` 必须**恒等于**构造期由宿主注入的权威令牌 `_identityAuthority`；
  不相等即 `identity_authority_denied`。
  方向很重要：若由 Core 首个调用者领取令牌，等于「谁先来谁就是身份权威」，
  只是把自报换成先到先得。
- `assertIdentity` 登记的值是**授权等级的唯一真相**；调用时 `opts.scope` 只用于比对，
  超出登记值即拒绝（`scope` 只降不升）。
- **诚实边界**：进程内 JS 没有安全隔离。能取得 Core 引用并读到
  `core._identityAuthority` 的代码仍可自证。本契约消除的是**静默自证**，
  不构成安全边界。真正的隔离要求不可信插件出进程执行。
  这一点必须写进对外承诺，不得含糊。

---

## 3. scope 是有限值类型

- 取值集合**恰好**是 `read | write | admin`，等级 `1 | 2 | 3`；`admin` 蕴含 `write`，`write` 蕴含 `read`。
- 判据必须是**自身属性**判定（`Object.hasOwn` 或 `Map`），不得用 `in` 或裸下标。
  理由：`'toString' in {}` 为真，裸下标会取到原型链上的函数；
  `(函数 ?? 0)` 不是 `0`，任何数值比较都返回 `false`，于是「等级不足」这条判据
  对非法值**恒假**——即 fail-open。
- 非法 scope **永不**满足任何 `permissions.scope` 要求；读写两端用同一张表。

---

## 4. 能力注册与归属

`Core#registerCapability(id, config)`：

1. **provider 只能来自受信装配上下文**。没有受信上下文时 `provider` 为 `null`，
   而不是退化成自报的 `config.owner`。
2. **覆盖判据读 provider**：仅当 `existing.provider === 新 provider`（非空）**且**
   显式 `override: true` 时才允许替换；否则 `capability_conflict`。
   读 `owner` 时，一个自报 `owner: 'A'` 的插件可以静默顶掉 A 的能力。
3. **世代闸门**：装配上下文带 epoch 时，`epoch` 必须仍是当前世代；
   否则 `assembly_superseded`。不带 epoch 的上下文**不得**因此被当作当前世代放行。
4. **停机闸门**：`stopping`/`stopped` 期间拒绝一切新登记（与世代无关）。
5. **override 不得丢合同字段**：未声明的字段继承旧值，不得只带 `permissions` 就抹掉
   `input_schema` 的 `required`。

---

## 5. 释放、回收与接管

| 入口 | 规范 |
|---|---|
| `releaseCapability(id, owner)` | 只有**已登记主体**能释放自己的登记；不得因公开 `owner` 字符串相等而放权。`owner` 省略**不等于**有权放权 |
| `releaseCapabilitiesByOwner(owner)` | **生命周期内部**清场入口，依据装配账本（本次装配发布了哪些 id），不是按名字扫全表 |
| `releaseServicesByOwner(owner)` | 同上；宿主接管（`@host`）条目不得被任何插件按名拆走 |
| `registerService(name, obj, opts)` | 宿主接管需要真实宿主能力或受信上下文；不得仅因 `claimant == null` 推断为宿主，也不得仅因名字等于 `@host` 就认作宿主 |
| 迟到清理 | 旧世代装配的回收不得误删**同 ID 的新一代**登记：回收按登记标识，不按名字 |

---

## 6. 能力声明：schema 支持表

能力用 JSON-Schema 的一个**受限子集**声明输入/输出。

### 6.1 支持的关键字（**整棵树的白名单**；own 属性与根类型自 rc.34 起真判）

白名单就是实现真正会执行的那点东西。**不在表里的一律注册期具名拒绝**，不是"忽略"。

| 位置 | 关键字 | 语义 |
|---|---|---|
| 根 | `type` | **7 个 JSON 类型全部在运行期真判**（`integer` 走 `Number.isInteger`）。声明了就必须执行，不支持判断的类型不接受 |
| 根 | `required: string[]` | 逐个判**own** 属性：`Object.getOwnPropertyDescriptor(params, k)` 存在且值不是 `undefined`；缺失即具名拒绝。原型链上的同名属性**不算提供** |
| 根 | `properties` | 属性名 → 子表；**属性名是任意字符串**（`__proto__` / `constructor` / `toString` 都按普通键处理，只看 own） |
| 属性子表 | `type` | 与实参运行时类型比对；`integer` 用 `Number.isInteger`（不能用 `typeof v === 'number'`，否则 `1.5` 放行） |
| 根/子表 | `title`、`description`（字符串） | **纯注释**：不携带任何断言，因此允许出现；写成非字符串则拒绝（避免读者以为那里能放断言） |
| 根 | `additionalProperties: boolean` | **仅允许出现，不参与校验**（no-op，不是已支持的约束） |

**属性子表只有一层**：本内核不递归校验对象子结构，所以子表里再出现 `properties` / `items`
一律拒绝 —— 那正是 rc.32 被专家击穿的地方（`properties.x.properties.admin.$ref` 被接受）。

**根类型的判据是"声明"**：写了 `type` 就按它判；没写 `type` 但写了 `required`/`properties`
即视为「声明了结构化输入契约」，此时 `params` 为 `null` / 字符串 / 数字 / 数组一律拒绝；
两者都没写的能力**不校验入参**（不校验 ≠ 全拒：`42`、`'x'`、`null` 都照旧放行）。

**只认 own 属性**：`required` 与 `properties.x.type` 都只看 `params` 自己的属性。
`{}` 上没有 own 的 `__proto__`，所以 `required:['__proto__']` **不成立** ——
「继承来的那个对象」不构成"调用方提供了这个字段"。own 但值为 `undefined` 同样不算提供（JSON 没有 `undefined`）。

**参数必须是纯数据**：要按属性判，参数根就必须是普通对象或 `Object.create(null)`。
类实例（自定义原型）与 `Proxy` 被具名拒绝 —— 它们的属性读取不受登记方控制，
拿它们当准入依据等于让输入自己决定校验结论。这是**准入判据的完整性**，不是安全隔离：
同进程能拿到 `Core` 实例的代码本来就能绕过一切。

### 6.2 注册时**具名拒绝**的关键字

`enum`、`const`、`oneOf`、`anyOf`、`allOf`、`not`、`pattern`、`format`、
`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`、
`minLength`、`maxLength`、`items`、`minItems`、`maxItems`、`uniqueItems`、`$ref`

判定范围是**整棵树**（根 + 每个属性子表），并且拒绝理由里带**路径**
（`$.properties.x`）与关键字名。rc.32 的实现只枚举 `properties` 的第一层，
于是根上的 `$ref` 与深层嵌套的 `$ref` 都被接受并执行成功 —— 已修。

**为什么拒绝而不是忽略**：这些关键字里有一批是**安全关键**的（`enum` 限值、
`pattern` 形状、`minimum` 下界、`maxLength` 长度）。静默忽略等于「声明了但不执行」，
调用方以为自己受约束、实际没有。fail-closed 的代价是一个注册期报错；
fail-open 的代价是一个看起来有校验、实际裸奔的能力。

---

## 7. 保留名与命名

- 宿主归属哨兵（`@host`）与 Core 内部哨兵名不得作为插件清单名被登记。
- 校验必须发生在**唯一注册入口**，且 `PluginManager.loadOne`、直接 `Core.register`、
  场景装载与发现路径都不得绕过。
- 兼容性：不得生搬硬套某个正则误伤既有包名（下划线、大小写、scope 前缀）。
  收紧前先列出仓库内全部现有名字并逐个回归。

---

## 8. 版本与兼容

- 本契约的破坏性变更（收紧拒绝面、改变覆盖判据、改变释放语义）必须以 ADR 记录，
  并明确「旧行为 → 新行为」与受影响调用方。
- 公开方法签名变更不得静默进行：可读字符串不得在无提示的情况下变成安全令牌，
  反之亦然。

---

## 9. 当前实现状态（唯一允许写「已达标/未达标」的地方）

基线 `2e74bc7` / `0.16.0-rc.14`。状态词取 `verification/contracts/oss-core-v1.md` 的定义。

| 条款 | 状态 | 证据指针 |
|---|---|---|
| §2 身份断言需权威令牌 | `IMPLEMENTATION_PASS` | `core.js` `assertIdentity` 比对 `issuer !== this._identityAuthority`；单测 `test-k15-k17` |
| §2 进程内不可信插件不隔离（诚实边界） | `IMPLEMENTATION_PASS`（**是负面事实的如实登记**） | 插件可读 `core._identityAuthority` 后自证；`core.js` 该方法注释已自认 |
| §3 scope 自身属性判定 | `IMPLEMENTATION_PASS` | `SCOPE_RANK` 已改 null 原型 + `Object.hasOwn`（4 处：`assertIdentity` 与两处等级比较）；`toString/constructor/__proto__/valueOf/hasOwnProperty` 全拒，`read/write/admin` 不变。证据：`test/run-one.mjs test/unit/test-r019-scope-and-ownership.test.mjs` 1–4 |
| §4.1 provider 只来自受信上下文 | `IMPLEMENTATION_PASS` | `provider = trusted ? asm.owner : null`；`store.trusted = (epoch != null)`，所以公开 `runServiceTracking`（`epoch:null`）铸不出受信来源。证据：R0-019/6、R0-019/8 |
| §4.2 覆盖判据读 provider | `IMPLEMENTATION_PASS` | 覆盖需「已有条目带受信 provider + 本次注册受信 + 两者相等」；两边都无来源时保留原同 owner 判据（宿主/历史兼容）。证据：R0-019/5、7、9 |
| §4.3 世代闸门 | `IMPLEMENTATION_PASS`（能力）/ `IMPLEMENTATION_COUNTEREXAMPLE`（服务，经 `runServiceTracking` 的 `epoch:null` 路径） | `registerCapability` 有 `isAssemblyCurrent` 判定；`registerService` 的判定被 `epoch == null` 短路 |
| §4.4 停机闸门 | `IMPLEMENTATION_PASS` | `_assertRegistrationOpen` |
| §4.5 override 不丢字段 | `IMPLEMENTATION_PASS` | `inherit()` 逐字段继承；单测覆盖 |
| §5 `releaseCapability` 不按字符串放权 | `IMPLEMENTATION_COUNTEREXAMPLE` | 仍是 `existing.owner !== owner` 字符串比较：声明 `owner` 相同即可释放他人能力。修它需要先设计「登记标识 / 受信释放入口」并改完调用点，见 ADR-08 修订节 |
| §5 内部清场按装配账本 | 部分 `IMPLEMENTATION_PASS` | `discardAssemblyArtifacts(store)` 按记账 id 精确回收（装配失败路径）；但卸载路径仍走 `releaseCapabilitiesByOwner(pluginName)` 按名扫表 |
| §5 宿主接管不得由名字推断 | `IMPLEMENTATION_PASS` | `takeover` 需 `claimant == null && opts.takeover === true`，并记 `_serviceTakeovers` |
| §6 schema 支持面 | `IMPLEMENTATION_PASS` | 注册期 `_assertSchemaSupported` 按**整棵树**白名单具名拒绝；运行期 `_schemaViolation` 按**声明**逐条判（根 `type` 真判、`required`/属性类型只认 **own** 属性、参数根必须是纯数据）。证据：`test/unit/test-rc33-…`（支持面）+ `test/unit/test-rc34-k33-schema-own-root-and-close-facts.test.mjs`（own/根类型/纯数据，17 条先红后绿）+ 探针 `test/probes/rc34-k33-independent-repro.mjs`。边界：只覆盖 `registerCapability` 声明的 `input_schema`，不是外部安全隔离 |
| §7 保留名在唯一入口拒绝 | `NOT_RUN` | 尚无跨入口（`loadOne` / `Core.register` / 场景）的统一保留名校验与正反例 |

**这张表的用途是防止把规范读成实现。** 任何一项从 `COUNTEREXAMPLE` 变成 `PASS`，
必须在同一次提交里附上「修前复现 + 修后拒绝 + 原合法正例」三类证据，
并把 `verification/contracts/oss-core-v1.md` 的对应行同步更新。
