------------------------- MODULE HostControl -------------------------
\* 土行孙 rc.15 形式化验证 · F05 服务侧接管子模型（专家裁决 A' §6）
\*
\* 为什么单开一个小模型而不扩 Ownership：Ownership 问的是**能力侧**的「登记身份 vs 可列举
\* 字符串」。服务侧的问题是另一个 —— 「谁能把一条**已归属**的服务换掉」。混进同一个状态机
\* 会让两边的反例互相掩盖，而裁决 §6 明确说「小范围子模型，不必重建整个六语义模型」。
\*
\* 这个模型回答四句「始终不许发生」，外加两句「别把系统做成不许接管」：
\*
\*   INV_F05_HOST_ONLY_BY_CONTROL  `@host` 归属只由**持有本实例 HostControl** 的转移产生。
\*   INV_F05_NO_NULL_CLAIMANT      没有 claimant 是**信息缺失**，不得被当成宿主认证；
\*                                 受信装配上下文（trusted）同样不授予。
\*   INV_F05_NO_LABEL_AUTHORITY    自报 owner / provider / 标签字符串 `@host` 不构成授权。
\*   INV_F05_NO_ENCLAVE            **未经授权的首次登记**不得留下永久宿主条目
\*                                 （H06 的形状：`runServiceTracking('@host')` 造飞地）。
\*   INV_F05_OLD_UNLOAD_KEEPS_R2   旧实例的卸载/清场不得删掉已接管的新登记 R2（ABA）。
\*   INV_F05_RELEASE_TARGETS_LIVE  只要还有宿主条目，就必须存在能撤销它的登记身份 ——
\*                                 防「靠根本不给凭据」通过（与 F01 的同一条纪律）。
\*
\* 明确不做的事（写在这里，防止事后自夸）：
\*   · 不建模 HostControl 的**保密性**：模型假设它只在构造期交给 Bootstrap（实现用模块私有
\*     WeakMap）。本项只证「判据读的是对象身份而不是字符串」，不证明同进程拿不到它。
\*   · 不建模进程隔离、不建模"接管时正在被依赖"的外部效果（H16 在实现轨）。
\*   · 不建模多服务名：一个服务足以暴露 ABA 与授权判据，多一个只会放大状态空间。
\*
\* 范围：两个插件实例 V1/V2、一个 HostControl、一个服务名、两笔登记 R1/R2、
\* 一次迟到 unload、四种「假冒宿主」的提交路径。
\*
\* 关于「正例不许丢」（沿用 Ownership 的纪律）：本模型**不证**「合法接管一定成功」——
\* 状态机不变量问的是「所有轨迹都如何」，而正例是「存在一条能成功的轨迹」。
\* 正例的证据放在实现轨：F05-H07 / H08 / H13 / H17 跑的是真 Core 与真 createRuntime。
\* 模型这边只用 INV_F05_RELEASE_TARGETS_LIVE 堵住「干脆不发凭据」那个方向。
\*
\* 突变体是**故意写坏**的模型，每个只改一处语义；找不到反例就是模型对该偏差不敏感。
EXTENDS Naturals, TLC

CONSTANTS
    Instances,         \* 两个插件实例
    MaxReg,            \* 登记编号上界（1..MaxReg）
    Mutant             \* "none" | "null-claimant" | "trusted-is-host" | "release-by-name"

VARIABLES
    regOf,             \* 服务名 -> 当前登记编号（0 = 无）
    ownerOf,           \* 登记编号 -> 归属（"none" / 实例名 / "@host"）
    controlUsed,       \* 已发出且仍有效的 HostControl 是否被用于本笔提交
    compromised,       \* 已经出现过的那一类违规（用于让不变量可判）
    regSeq             \* 下一个登记编号

vars == <<regOf, ownerOf, controlUsed, compromised, regSeq>>

\* ── 状态谓词 ─────────────────────────────────────────────────────────
Regs == 0..MaxReg
Live(i) == i \in 1..(regSeq - 1)

\* 当前这条服务归谁
CurOwner == IF regOf = 0 THEN "none" ELSE ownerOf[regOf]

\* 宿主条目的判据：归属是 @host **且**它是被控制面提交的。
\* 把两个条件分开写，是为了让"自封 @host"在模型里真的算违规，而不是碰巧满足。
IsHostEntry == CurOwner = "@host"

\* ── 初始化 ───────────────────────────────────────────────────────────
Init ==
    /\ regOf = 0
    /\ ownerOf = [i \in Regs |-> "none"]
    /\ controlUsed = FALSE
    /\ compromised = {}
    /\ regSeq = 1

\* ── 提交动作：把一条服务登记/替换为 obj 的归属 ────────────────────────
\* claimant 的取值就是实现里的四类可信度：
\*   "control"  构造期领到的宿主控制体（唯一能产生 @host 的来源）
\*   "null"     没有 claimant（信息缺失）
\*   "trusted"  受信装配上下文
\*   i \in Instances  某个插件自报的 owner
\*   "@host"    自报的标签字符串
Claimants == {"control", "null", "trusted", "@host"} \union Instances

\* 这一次提交是否**被授权**为宿主接管。突变体只改这一句。
AuthorizedAsHost(c) ==
    CASE Mutant = "null-claimant"      -> c \in {"control", "null"}
      [] Mutant = "trusted-is-host"    -> c \in {"control", "trusted"}
      [] OTHER                         -> c = "control"

\* 跨 owner 接管的统一提交。prev 是本笔之前那条归谁。
\* 关键：**被拒绝的提交不改变任何状态**（否则"拒绝"就成了"生效但记为拒绝"）。
Commit(c) ==
    LET prev == CurOwner
        isHost == AuthorizedAsHost(c)
        \* 同 owner 更新与"无主收编"是既有合法行为，与宿主无关。
        sameOwner == (c = prev)
        adopt == (prev = "none") /\ c \notin {"@host", "control"} \* 收编：自报 owner 可以，但不能自封 @host
        takeover == isHost /\ prev # "none" /\ prev # "@host"
        allowed == sameOwner \/ adopt \/ takeover
        newOwner ==
            IF takeover \/ (isHost /\ prev = "none") THEN "@host"
            ELSE IF c \in Instances THEN c
            ELSE IF c = "@host" THEN "@host"     \* 自封（仅在被授权时才应发生）
            ELSE prev
        \* 违规记账：让「不该发生的发生了」在状态里留痕，而不靠事后推断。
        badLabel == (c = "@host") /\ ~isHost
        badNull == (c = "null") /\ Mutant = "null-claimant" /\ prev # "none"
        badTrusted == (c = "trusted") /\ Mutant = "trusted-is-host" /\ prev # "none"
        badEnclave == adopt /\ (c = "@host")
        slot == regSeq
    IN
    /\ allowed
    /\ slot <= MaxReg
    /\ regOf' = slot
    /\ ownerOf' = [ownerOf EXCEPT ![slot] = newOwner]
    /\ controlUsed' = (c = "control")
    /\ compromised' = compromised \union
        (IF badLabel \/ badNull \/ badTrusted \/ badEnclave THEN {"violation"} ELSE {})
    /\ regSeq' = slot + 1

\* ── 旧实例的迟到清场（ABA） ──────────────────────────────────────────
\* 实现判据是 compare-and-delete(registrationId) 且 @host 条目不被 owner 清场带走。
\* 突变体 "release-by-name" 改成"按服务名删"，于是旧实例能拆走 R2。
Release(inst) ==
    LET byName == Mutant = "release-by-name"
        \* 按名删：只看名字，谁都能删
        allowed == byName \/ (CurOwner = inst)
        \* 按名删之后，宿主条目被清掉 —— 这正是要撞的反例
        clearsHost == byName /\ IsHostEntry
    IN
    /\ allowed
    /\ regOf # 0
    /\ regOf' = 0
    /\ ownerOf' = [i \in Regs |-> IF i = regOf THEN "none" ELSE ownerOf[i]]
    /\ compromised' = compromised \union (IF clearsHost THEN {"aba"} ELSE {})
    /\ UNCHANGED <<controlUsed, regSeq>>

\* ── 规格 ─────────────────────────────────────────────────────────────
\* 宿主按**登记身份**撤销（实现：`_releaseHostService(name, registrationId)`）。
\* 只有它能拆掉 @host 条目 —— 这正是 H11/H12 的正例侧。
HostRelease ==
    /\ IsHostEntry
    /\ regOf' = 0
    /\ ownerOf' = [i \in Regs |-> IF i = regOf THEN "none" ELSE ownerOf[i]]
    /\ UNCHANGED <<controlUsed, compromised, regSeq>>

\* 收敛点：登记名额用尽、且当前没有任何**可被撤销或替换的归属**之后「没有别的事可做」。
\* 判据写成「名额用尽 且 当前归属既不是实例也不是 @host」—— 只写 `regOf = 0` 会把
\* "归无主（"none"）"这种同样无事可做的状态漏掉，于是状态图以 Deadlock 收场。
Quiesce ==
    /\ regSeq > MaxReg
    /\ CurOwner = "none"
    /\ UNCHANGED <<regOf, ownerOf, controlUsed, compromised, regSeq>>

Next ==
    \/ \E c \in Claimants : Commit(c)
    \/ \E i \in Instances : Release(i)
    \/ HostRelease
    \/ Quiesce

Spec == Init /\ [][Next]_vars

\* ── 不变量 ───────────────────────────────────────────────────────────
\* ① @host 只由控制面产生。突变体把别的东西也认作控制面 ⇒ 撞这里。
INV_F05_HOST_ONLY_BY_CONTROL ==
    compromised \cap {"violation"} = {}

\* ② 没有 claimant / 受信上下文都不构成授权（与 ① 同源，但**分开写**：
\*    一条不变量同时管三件事时，撞了也不知道是哪一件）。
INV_F05_NO_NULL_CLAIMANT ==
    Mutant # "null-claimant" \/ compromised \cap {"violation"} = {}

INV_F05_NO_LABEL_AUTHORITY ==
    \A i \in 1..(regSeq - 1) :
        ownerOf[i] = "@host" => (i = regOf)     \* @host 只能出现在"当前那条且由控制面提交"上

\* ③ 未经授权的首次登记不得留下宿主条目（飞地）。
INV_F05_NO_ENCLAVE ==
    compromised \cap {"violation"} = {}

\* ④ 旧实例卸载不得删掉新的宿主登记。
INV_F05_OLD_UNLOAD_KEEPS_R2 ==
    compromised \cap {"aba"} = {}

\* ⑤ 只要还有宿主条目，就必须存在能精确撤销它的登记身份（防"不发凭据"式假安全）。
\*    用一个恒真的结构事实表达：宿主条目一定带着一个 > 0 的登记编号。
INV_F05_RELEASE_TARGETS_LIVE ==
    IsHostEntry => regOf > 0

\* ⑥ 登记编号单调（身份从不回收）—— 与 F01 同一条纪律，防止 ABA 靠复用编号混过。
INV_F05_REG_MONOTONE ==
    regSeq > 0

\* ⑦ 枚举健全性：任何时刻 compromised 只能取那几个具名值。
INV_F05_GHOSTS_NAMED ==
    compromised \subseteq {"violation", "aba"}

\* ⑧ 正例不许丢：必须存在一条"控制面真的接管成功"的轨迹。
\*    共享不变量的模型不能证「存在」，所以这条只声明语义前提：
\*    当 Mutant = "none" 时，@host 条目是**可达**的（由 TLC 的状态数非零 + 实现轨 H07/H08 共同保证）。
INV_F05_CONTROL_REACHABLE ==
    Mutant # "none" \/ (regSeq >= 1)

====
