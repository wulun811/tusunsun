# ADR-14：schema 支持面从「注册期拒绝」改为「登记 + 具名告警 + 逐条记账」

- 状态：**已采纳并接线**（v0.20.2）
- 日期：2026-11-02
- 触发：真实接入实测（7 个 MCP 工具里 6 个装不上）
- 相关：ADR-03（code 归属）、ADR-11（错误分类加性字段）、`contracts/capability-identity-v1.md` §6

---

## 1 问题：抛错的粒度是能力，代价是插件

`registerCapability` 在注册期按白名单判 schema，白名单外的关键字**抛错**。抛错的单位是
一个能力，承担后果的却是一整个插件：插件在自己的 `registerCapabilities()` 里逐个注册，
一个能力抛了，整个方法中止，插件装载失败并从进程里消失。

真实接入实测（MCP 工具契约）：7 个里 6 个用了 `enum` / `pattern` / `items` / `type: [...]` /
嵌套 `properties` / `minLength` ⇒ 6 个装不上。唯一绕法是每个使用方自己写一遍「窄投影 +
自校验」，于是同一份契约在 N 个地方各实现一遍，语义必然漂移。

内核自己的工具也走过同一条绕路：`plugins/tools/lib/schema.mjs#declarableSchema`。

## 2 决策

注册期不再拒绝。schema 体检改为**收集**：

- 支持面内的约束照常执行（首轮改动未动 `_schemaViolation`；后续为 `type` 并集扩了类型判据，见 §5）；
- 支持面外的关键字逐条记成 `{ code, path, keyword, which, assertional }`，存在能力条目上
  （`schema_unvalidated`），并从 `listCapabilities()` 可枚举；
- 注册时打一条 `[schema]` 告警，列出前几个关键字与路径，并标明是否含「能改变准入结论」的关键字。

`assertional` 取自 `UNSUPPORTED_SCHEMA_KEYWORDS`：`pattern` / `enum` / `$ref` 这类能改变准入
结论的关键字，与 `title` 之类纯注释区分开 —— 前者的「未生效」才是风险。

## 3 为什么这不是 fail-open

旧论证是「静默忽略 = 声明了但不执行」。这句话对，但它把两件事混成了一件：**约束没生效**
与 **插件不可用**。前者必须可见，后者不是必须的。

新口径同时保证三件事：

1. 插件不会因为一个能力写宽了而消失；
2. 「声明了但没判」在注册日志、能力条目、`listCapabilities()` 三处都可查；
3. 能判的部分仍然真判（`required` / `type` / 根类型 / 参数必须是纯数据），
   不因为放宽注册而放宽执行。

反过来说，保留拒绝的代价是可验证的：6/7 的真实工具契约不可用，且每个使用方各写一份投影。

## 4 影响与迁移

- 兼容性：**收紧面放宽**（新增接受）属破坏性变更 —— 拿「抛错」做校验的宿主需要改读
  `schema_unvalidated`。按 `contracts/capability-identity-v1.md` §8 记 ADR，即本文件。
- `declarableSchema` 仍保留：给模型看的 `parameters` 与校验层分离本身有价值，且它对旧宿主无害。
- 证据：`test/unit/test-r0-177-schema-register-and-warn.test.mjs`（4 条）；既有契约用例
  按新口径改写：`test-rc33-owner-settle-close-schema`（4 条）、
  `test-rc32-task-transaction-and-decl-snapshot`（2 条）、`test-r0-permission-boundary`（R0-28/I）。
- 未做：把**执行面**扩到 draft-07 常用子集（`enum` / `items` / `pattern` / `minimum` /
  `maxLength`）。那是另一轮设计 —— `pattern` 带正则回溯成本（ReDoS 面），不能顺手加。

## 5 补记：`type` 数组并集与 `assertional` 判据

首轮改动之后暴露出一条同类缺陷：`type: ['integer','null']`（draft-07 的并集）**登记成功、也记成了
`schema_unvalidated`**，但执行面把 `typeof` 的结果与数组做 `===`，恒不相等 —— 合法调用每次都被判
`invalid_input`。这正是 §3 要防的事：「记账说不生效、执行却恒假」，两者只能留一个。

修法（v0.20.2，+7 行）：

- `type` 判据认**字符串或数组并集**：`typeMatches()` 逐成员匹配（`integer` → `Number.isInteger`，
  其余 → 运行时类型），任一命中即通过；
- 判不了的 `type`（未知类型名、空数组）**不执行、只记账**，且 `assertional: true` —— 它确实改变
  准入结论（不再判），不能和 `title` 一样被当成无害；
- 同一处声明只记**一条**：根类型「判不了」（`$.type`）与「与结构化契约冲突」（`$`）是两种诊断，
  不再各记一遍（修前 `['strng','object']` + `properties` 会记两条）。

判据：`test/unit/test-r0-179-type-union.test.mjs`（5 条，修前 4 红）。
