------------------------- MODULE Ownership -------------------------
\* 土行孙 rc.15 形式化验证 · F01 Ownership：代持、登记身份、定向撤销
\*
\* 这个模型回答六句「始终不许发生」，外加两句「别把系统做成不许卸载」：
\*
\*   INV_F01_NO_STRING_AUTH    任何**可列举的字符串**（声明 owner / 登记 provider 名 /
\*                             能力名）都不得产生撤销或覆盖的权限。
\*   INV_F01_NO_ABA            一次迟到撤销只能指向它当初那笔登记；同 ID 的后继登记
\*                             不得被旧句柄删掉（ID-07/08/09）。
\*   INV_F01_REAP_SCOPED       生命周期清场只能按**登记实例身份**，不能按插件名 ——
\*                             重载后两个实例共用一个名字（ID-10/13）。
\*   INV_F01_HANDLE_TARGETS_LIVE  只要还有登记挂在能力名上，就必须存在指向它的句柄。
\*                             —— 这条是防「假安全」：如果参考模型靠"凭据根本不存在"
\*                             来通过，那它证明的不是授权，而是拒绝服务。
\*   INV_F01_HANDLE_IN_RANGE   句柄不得指向一笔还没铸出的登记（身份从不回收的前提）。
\*
\* 明确不做的事（写在这里，防止事后自夸）：
\*   · 不建模句柄的**保密性**：模型假设句柄不可枚举（真实实现用 WeakMap 私有绑定）。
\*     本项只证明「判据读的是登记身份」与「公开字符串没有授权力」，不证明句柄不可被窃取。
\*   · 不建模服务侧登记（`registerService` / `@host` 接管）：S6 的能力侧才是本模型的范围。
\*     服务侧现在有**自己的**子模型 `HostControl.tla`（专家裁决 A' §6），两份模型各自有
\*     状态空间、各自有突变体 —— 混成一张表会让两边的反例互相掩盖，缺行也看不出来。
\*     服务侧的 `epoch:null` 短路已在实现侧关闭（源码继承修复 + F05-REPLAY-02 重放）。
\*     实现已修不等于模型已证，这两件事必须分开写（本文件不覆盖它，HostControl.tla 覆盖判据侧）。
\*   · 不建模进程隔离。同进程拿到 Core 引用的代码本来就能改私有表（合同 §4 前提 1/4）。
\*
\* 范围（专家 S6 裁决 §6 的最小模型）：两个插件实例 X1/X2、一个公开能力名、
\* 两次登记 R1/R2、两个句柄 H1/H2、一次迟到 stop、一条错误释放路径。
\* 登记身份是 1..MaxReg 的编号，**只增不减**；句柄是另一个命名空间（Handles），
\* 由模型自己挑一枚没用过的 —— 两者刻意不同号，
\* 这样"把句柄本身当成登记身份"在模型里会真的错，而不是碰巧对。
\*
\* 关于「正例不许丢」（专家回函：「即使所有冒名不能释放都绿，也应判 NO-GO」）——
\* **本模型不证这一句，也不假装证了**：它问的是「存不存在一条能成功的轨迹」，
\* 而状态机不变量只能问「所有轨迹都如何」，两者问题类型不同。
\* 改成时态性质 `<>released` 会变成另一句话（"迟早会发"），TLC 实测它在参考模型
\* 自己身上就违反（Init 上可以永远不动）—— 那是模型写错，不是实现有缺陷。
\* 所以正例的证据放在**实现轨**：`test-r031` 的 ID-04/05/06/13 跑的是真 Core /
\* 真 LifecycleManager / 真 ToolLoader，问的就是「能不能」，且必须继续能。
\* 模型这边只用 INV_F01_HANDLE_TARGETS_LIVE 堵住「根本没有句柄、所以谁也删不掉」那个方向。
\*
\* 突变体是**故意写坏**的模型：每个 Mutant 值只改一处语义。找不到反例就是模型太弱，
\* 不是模型通过（见 run-formal.mjs 的 sensitivity 判定）。
\*
\* 注意 m10/m11 的方向与其它四个**相反**：它们要证的是「正例还在」，
\* 所以它们撞的是两条**下界**不变量（任一时刻都必须仍存在一条做得到释放/清场的路径），
\* 而不是上界（不许发生什么）。这两条是本文件里唯一写"能力"而不是"禁止"的地方。

EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS
    Instances,    \* 插件实例集合，如 {"X1", "X2"}
    Handles,      \* 句柄命名空间，如 {"hA", "hB"}
    MaxReg,       \* 登记上界：TLA+ 的 Nat 无界，不设界 TLC 跑不完
    Mutant        \* "none" | 六个故意写坏之一，见 MUTANTS 注释

ASSUME Instances # {}
ASSUME MaxReg >= 2
\* 每次登记铸一枚**尚未用过**的句柄，挑哪一枚由模型自己决定（见 MintRegister 的 \E h）。
\* 不让配置给定"第 k 笔 → 哪枚句柄"的顺序：那样"判据写成 h = active"会碰巧对上一次，
\* 那正是模型的漏洞（Lifecycle 的 m3 就是栽在这类人为约束上）。
ASSUME Cardinality(Handles) >= MaxReg

VARIABLES
    minted,        \* 已铸出的登记数。登记身份 1..minted 都存在，且**从不回收**：
                   \* 回收才能让一笔旧句柄"复活"，那正是 ABA 的入口。
    active,        \* 能力名当前挂在哪笔登记上（0 = 空着）
    regInst,       \* [1..MaxReg -> Instances] 登记实例（归责方，不可自选）
    regDecl,       \* [1..MaxReg -> Instances] 声明 owner（署名，**可公开**、无授权力）
    handleTarget,  \* [Handles -> 0..MaxReg] 句柄指向的那笔登记（0 = 尚未铸出）
    stringAuth,    \* 幽灵：某次撤销/覆盖是靠公开字符串过关的（检测器，不属实现状态）
    abaKill,       \* 幽灵：某枚迟到句柄删掉了**不是它指向的那笔**登记
    reapOutOfScope,\* 幽灵：按名清场删到了不属于该实例的登记
    released,      \* 幽灵：至少一次**凭句柄**的释放真的成功了（防一律拒绝）
    reaped         \* 幽灵：至少一次**按实例**的清场真的删掉了东西（防一律拒绝）

vars == <<minted, active, regInst, regDecl, handleTarget,
          stringAuth, abaKill, reapOutOfScope, released, reaped>>

(* ── 突变体（专家 S6 裁决 §6 三条 + 本仓补的三条）──────────────────────────
   m6-release-by-id            释放只判"这是个真句柄"，不判它是否仍指向当前那笔
                               —— 即 `delete(capability_name)` 而不是
                               `compare-and-delete(registration_id)`        → 撞 INV_F01_NO_ABA
   m7-release-by-string        释放凭公开字符串（provider 名 / 声明 owner）过关
                                                                           → 撞 INV_F01_NO_STRING_AUTH
   m8-late-reap-by-name        旧实例的迟到清场按**插件名**删（重载后同名）
                                                                           → 撞 INV_F01_REAP_SCOPED
   m9-owner-string-override    覆盖凭"声明 owner 字符串相等"过关
                                                                           → 撞 INV_F01_NO_STRING_AUTH
   m10-deny-all-release        释放一律拒绝（"不许卸载"也能让上面两条绿） → 撞 INV_F01_RELEASE_ENABLED
   m11-deny-all-reap           清场一律空转（"谁也别想卸载干净"）       → 撞 INV_F01_REAP_ENABLED
   ─────────────────────────────────────────────────────────────────────── *)

IsM6 == Mutant = "m6-release-by-id"
IsM7 == Mutant = "m7-release-by-string"
IsM8 == Mutant = "m8-late-reap-by-name"
IsM9 == Mutant = "m9-owner-string-override"
IsM10 == Mutant = "m10-deny-all-release"
IsM11 == Mutant = "m11-deny-all-reap"

\* 下一笔登记的序号。写成算子而不是散在动作里，是因为"下一笔是几号"只允许有一份答案。
NextK == minted + 1

Init ==
    /\ minted = 0
    /\ active = 0
    /\ regInst = [i \in 1..MaxReg |-> CHOOSE x \in Instances : TRUE]
    /\ regDecl = [i \in 1..MaxReg |-> CHOOSE x \in Instances : TRUE]
    /\ handleTarget = [h \in Handles |-> 0]
    /\ stringAuth = FALSE
    /\ abaKill = FALSE
    /\ reapOutOfScope = FALSE
    /\ released = FALSE
    /\ reaped = FALSE

\* 首次发布：能力名空着时，受信装配为某个实例铸一笔登记与一枚句柄。
MintRegister(i, d) ==
    /\ minted < MaxReg
    /\ active = 0
    /\ \E h \in Handles :
         /\ handleTarget[h] = 0                       \* 只铸没被用过的那枚
         /\ minted' = NextK
         /\ active' = NextK
         /\ regInst' = [regInst EXCEPT ![NextK] = i]
         /\ regDecl' = [regDecl EXCEPT ![NextK] = d]
         /\ handleTarget' = [handleTarget EXCEPT ![h] = NextK]
    /\ UNCHANGED <<stringAuth, abaKill, reapOutOfScope, released, reaped>>

\* 同名覆盖：这是**对某一笔登记**的处置，所以要的是那笔登记的句柄，
\* 不是"名字看起来一样"。覆盖铸一笔**新**登记与**新**句柄，旧句柄原地作废。
OverrideWithHandle(h, i, d) ==
    /\ minted < MaxReg
    /\ active # 0
    /\ (IF IsM9 THEN regDecl[active] = d ELSE handleTarget[h] = active)
    /\ \E h2 \in Handles :
         /\ handleTarget[h2] = 0
         /\ minted' = NextK
         /\ active' = NextK
         /\ regInst' = [regInst EXCEPT ![NextK] = i]
         /\ regDecl' = [regDecl EXCEPT ![NextK] = d]
         /\ handleTarget' = [handleTarget EXCEPT ![h2] = NextK]
    \* 靠声明串过关 ⇒ 记一笔"字符串授权"；这不是绕过的旁证，而是判据本身被换掉了。
    /\ stringAuth' = (stringAuth \/ (IsM9 /\ handleTarget[h] # active))
    /\ UNCHANGED <<abaKill, reapOutOfScope, released, reaped>>

\* 凭句柄撤销。参考模型：只有指向**当前那笔**登记的句柄才删得掉（compare-and-delete）。
\* m6 把判据降级成"这是个真句柄"—— 于是旧句柄能删掉后继登记，ABA 成立。
ReleaseByHandle(h) ==
    /\ active # 0
    /\ handleTarget[h] # 0
    /\ ~IsM10
    /\ active' = IF IsM6 \/ (handleTarget[h] = active) THEN 0 ELSE active
    /\ abaKill' = (abaKill \/ (IsM6 /\ handleTarget[h] # active))
    /\ released' = (released \/ IsM6 \/ (handleTarget[h] = active))
    /\ UNCHANGED <<minted, regInst, regDecl, handleTarget, stringAuth, reapOutOfScope, reaped>>

\* 对手动作：手里只有**公开**的字符串（能力名、声明 owner、登记 provider 名）。
\* 参考模型里这条路径什么也改不动 —— 它不是"没实现"，而是"实现了但无权"。
\* m7 让它删得掉：那正是 E-3（`releaseCapability(id, ownerString)` 当口令用）的形状。
ReleaseByString(who) ==
    /\ active # 0
    /\ \/ /\ IsM7
          /\ (regInst[active] = who \/ regDecl[active] = who)
          /\ active' = 0
          /\ stringAuth' = TRUE
          /\ UNCHANGED <<minted, regInst, regDecl, handleTarget, abaKill, reapOutOfScope,
                         released, reaped>>
       \/ /\ ~IsM7
          /\ UNCHANGED vars

\* 生命周期按**登记实例身份**清场（ID-13 的正例：插件没保存任何句柄也能被清干净）。
\* m8 按插件名清 —— 重载后 X1 与 X2 共用一个名字，于是旧实例的收尾删掉了新实例的资产。
ReapInstance(i) ==
    /\ active # 0
    /\ ~IsM11
    /\ active' = IF IsM8 \/ (regInst[active] = i) THEN 0 ELSE active
    /\ reapOutOfScope' = (reapOutOfScope \/ (IsM8 /\ regInst[active] # i))
    /\ reaped' = (reaped \/ (~IsM8 /\ regInst[active] = i))
    /\ UNCHANGED <<minted, regInst, regDecl, handleTarget, stringAuth, abaKill, released>>

\* 迟到的那一次：新实例已经接手，旧实例的 stop() 才收尾。
\* 这条单独列出来，是因为"旧代清理删掉新代登记"只在**有后继**时才可能发生；
\* 没有后继时按名清场和按实例清场的结果一样，那种交错观察不到差异。
LateStopOfOldInstance(i) ==
    /\ active # 0
    /\ ~IsM11
    /\ \E j \in Instances : /\ j # i
                            /\ \E r \in 1..minted : regInst[r] = j
    /\ active' = IF IsM8 \/ (regInst[active] = i) THEN 0 ELSE active
    /\ reapOutOfScope' = (reapOutOfScope \/ (IsM8 /\ regInst[active] # i))
    /\ reaped' = (reaped \/ (~IsM8 /\ regInst[active] = i))
    /\ UNCHANGED <<minted, regInst, regDecl, handleTarget, stringAuth, abaKill, released>>

\* 系统没有别的事可做时的空转。
\* 本模型**不依赖**任何公平性：不变量在全部交错上成立，不需要"宿主迟早会做点什么"。
Quiesce == UNCHANGED vars

Next ==
    \/ \E i \in Instances : \E d \in Instances : MintRegister(i, d)
    \/ \E h \in Handles : \E i \in Instances : \E d \in Instances : OverrideWithHandle(h, i, d)
    \/ \E h \in Handles : ReleaseByHandle(h)
    \/ \E who \in Instances : ReleaseByString(who)
    \/ \E i \in Instances : ReapInstance(i)
    \/ \E i \in Instances : LateStopOfOldInstance(i)
    \/ Quiesce

Spec == Init /\ [][Next]_vars

(* ── 安全性质 ─────────────────────────────────────────────────────────── *)
\* F01①：可列举的字符串不构成授权。
INV_F01_NO_STRING_AUTH == ~stringAuth

\* F01②：撤销是 compare-and-delete(登记身份)，迟到句柄不得危及后继登记。
INV_F01_NO_ABA == ~abaKill

\* F01③：清场按登记实例身份，不按名字。
INV_F01_REAP_SCOPED == ~reapOutOfScope

\* F01④：挂在能力名上的登记一定有一枚指向它的句柄。
\* 否则"谁都不能删"会让前三条全部为真 —— 那是 deny-all，不是授权。
INV_F01_HANDLE_TARGETS_LIVE == (active # 0) => (\E h \in Handles : handleTarget[h] = active)

\* F01⑤：句柄不得指向一笔还没铸出的登记（身份从不回收的前提）。
INV_F01_HANDLE_IN_RANGE == \A h \in Handles : handleTarget[h] <= minted

\* F01⑥：**幽灵变量只能是 BOOLEAN**。
\* 这条看着像废话，它抓的却是真事：TLA+ 里 `=` 比 `\/` 优先，
\* `x' = x \/ y` 会被解析成 `(x' = x) \/ y` —— 于是写下的根本不是赋值，
\* 而是「要么不赋值、要么 …」。实测里它表现为 TLC 输出 `released = null`，
\* 而 `-nowarning` 下 TLC 静默接受。布尔约束把这类错误在**模型层**就变成反例。
INV_F01_GHOSTS_BOOLEAN ==
    /\ stringAuth \in BOOLEAN
    /\ abaKill \in BOOLEAN
    /\ reapOutOfScope \in BOOLEAN
    /\ released \in BOOLEAN
    /\ reaped \in BOOLEAN

(* ── 下界性质：正例必须仍在（专家回函「正例不许丢」）──────────────────────
   这四个突变体里有两条是**反方向**的：m10 把释放做成一律拒绝、m11 把清场做成空转。
   「谁都不能释放」会让上面六条全部为真 —— 那不是安全，那是把系统变成不许卸载。
   所以这两条问的不是「不许发生什么」，而是「此刻还做不做得成」。

   为什么能写成状态不变量而不写 `<>released`：本模型的合法释放/清场只依赖
   **当前这一份状态**（有没有登记、有没有指向它的句柄、它属于谁），不依赖历史。
   所以「此刻做不做得成」就是一句状态谓词，不需要轨迹。
   我第一次写成 `<>(released)`，TLC 在**参考模型自己身上**就报了反例
   （Init 上 active = 0，Quiesce 自环，永远不到达释放）——
   那不是实现有缺陷，是把「存在一条成功路径」错写成「迟早会发生」。
   改成状态谓词之后，m10/m11 照样被杀死，而参考模型干净通过。                *)

\* 只要还有登记挂着，就必须**真的还撤得下来**。
\*
\* 用 `ENABLED`，因为这一句问的是"动作此刻可不可发"，不是"有没有发生过"。
\* 三次写错的过程留在这里，因为每一种错法都会让模型虚假地变绿：
\*   ① `<>released`      —— 变成"迟早会发"，Init 上 Quiesce 自环就把它绕过去了；
\*   ② `IsM10 \/ …`     —— 突变体给自己开后门，m10 直接存活；
\*   ③ `handleTarget` 存在 —— "一律拒绝"时句柄照样在，只是没人能用它，m10 再次存活。
\* 只有 ENABLED 同时挡住了这三种错。
INV_F01_RELEASE_ENABLED ==
    (active # 0) => (\E h \in Handles : ENABLED ReleaseByHandle(h))

\* 同理：清场路径必须真的还发得出来 —— 否则"卸载干净"就成了不可能的事。
INV_F01_REAP_ENABLED ==
    (active # 0) => (\E i \in Instances : ENABLED ReapInstance(i))

=============================================================================
