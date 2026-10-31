------------------------- MODULE ServiceRegistration -------------------------
\* 土行孙 rc.17 形式化验证 · 服务登记身份子模型（R16-01 §5）
\*
\* 为什么单开一份：HostControl 问的是「谁能把一条已归属的服务换掉」，Ownership 问的是
\* 能力侧的登记身份。这里问的是第三个问题 —— 「一次**登记**被撤销时，凭据是否还指向
\* 当前这一笔」。三者的反例形状不同，混进同一张状态机表会互相掩盖（HostControl 头注已记
\* 过这条经验）。
\*
\* 状态维度照专家给的取：serviceId（本例用单调编号 1..MaxReg）、registrar（A / @host）、
\* attempt（装配账由哪一笔装配记下）、serviceRecord（服务对象在不在）、failure（装配是否
\* 已失败）、takeoverReceipt（接管回执指向哪一笔）。
\*
\* 三条「始终不许发生」：
\*   INV_SR_CLEANUP_NO_WRONG_DELETE  旧 attempt 的失败清理不得改变**新** ID 的服务对象与归属。
\*   INV_SR_NO_DANGLING_ID           `record = "absent"` 时不许还留一个活的登记 ID / 接管回执；
\*                                   否则按旧 ID 释放会对已经不存在的服务返回成功（幽灵回执）。
\*   INV_SR_NO_DANGLING_TAKEOVER     接管回执必须指向当前那条宿主登记。
\*
\* 下界（正例侧）不写在模型里：共享不变量只能问「所有轨迹都如何」，问不了「存在一条能成功
\* 的轨迹」。撤销自己那笔、宿主按精确 ID 释放、同名重载不误伤，都由实现轨 R16-01c/d/h/j
\* 跑真 Core 证明。
\*
\* 明确不做的事：不建模多服务名、不建模并发线程（登记提交在 JS 里是同步原子段）、
\* 不建模进程隔离。范围见 run-formal.mjs 的 SCOPE.ServiceRegistration。
EXTENDS Naturals, TLC

CONSTANTS
    Attempts,          \* 两笔装配 attempt
    MaxReg,            \* 登记编号上界（1..MaxReg）
    Mutant             \* "none" | "cleanup-by-name" | "release-by-orphan-id"

VARIABLES
    receipt,           \* attempt -> 它账上记的登记 ID（0 = 没记）
    failed,            \* 已失败的 attempt 集合
    record,            \* "present" | "absent"（服务对象）
    owner,             \* "none" | "A" | "@host"
    regId,             \* 当前活着的登记 ID（0 = 无）
    takeover,          \* 接管回执指向的登记 ID（0 = 无回执）
    seq,               \* 下一个登记编号
    viol               \* 已发生的违规（让「不该发生的发生了」在状态里留痕）

vars == <<receipt, failed, record, owner, regId, takeover, seq, viol>>

Ids == 0..MaxReg
Live == record = "present" /\ regId # 0

\* 撤销一笔登记 = 五个账一起清（实现里的 `_discardServiceReceipt` 那一句）。
ClearAll ==
    /\ record' = "absent"
    /\ owner' = "none"
    /\ regId' = 0
    /\ takeover' = 0

Init ==
    /\ receipt = [a \in Attempts |-> 0]
    /\ failed = {}
    /\ record = "absent"
    /\ owner = "none"
    /\ regId = 0
    /\ takeover = 0
    /\ seq = 1
    /\ viol = {}

\* 装配失败：账还留着，人已经倒了。清理是**之后**单独的一步 —— 真实实现里它发生在
\* `_load` 的 catch，与失败本身隔着若干次 await，正是交错得以出现的地方。
Fail(a) ==
    /\ a \notin failed
    /\ failed' = failed \union {a}
    /\ UNCHANGED <<receipt, record, owner, regId, takeover, seq, viol>>

\* 一笔装配发布服务。首次登记才允许（收编/覆盖是 HostControl 的话题，不在这里重复）。
Register(a) ==
    /\ a \notin failed
    /\ receipt[a] = 0
    /\ record = "absent"
    /\ seq <= MaxReg
    /\ record' = "present"
    /\ owner' = "A"
    /\ regId' = seq
    /\ takeover' = 0
    /\ receipt' = [receipt EXCEPT ![a] = seq]
    /\ seq' = seq + 1
    /\ UNCHANGED <<failed, viol>>

\* 宿主把这条服务接管成自己的：新 ID、新归属、写回执。
HostTakeover ==
    /\ record = "present"
    /\ owner = "A"
    /\ seq <= MaxReg
    /\ owner' = "@host"
    /\ regId' = seq
    /\ takeover' = seq
    /\ seq' = seq + 1
    /\ UNCHANGED <<receipt, failed, record, viol>>

\* 失败装配的清理回放。判据是**收据里的 ID 是否仍指向当前那一笔**。
\*   none                 : 比对 ID 且只清自己那笔（正确）
\*   cleanup-by-name      : 只看服务名还在就清 —— 对象与归属被清，登记 ID 与回执留着
\*                          （rc.16 的 `discardAssemblyArtifacts` 就是这个形状）
Cleanup(a) ==
    LET byName == Mutant = "cleanup-by-name"
        own == receipt[a]
        deletes == IF byName THEN record = "present" ELSE (Live /\ regId = own)
        steals == deletes /\ regId # own
    IN
    /\ a \in failed
    /\ receipt[a] # 0
    /\ deletes
    /\ record' = "absent"
    /\ owner' = "none"
    /\ regId' = IF byName THEN regId ELSE 0
    /\ takeover' = IF byName THEN takeover ELSE 0
    /\ UNCHANGED <<receipt, failed, seq>>
    /\ viol' = viol \union (IF steals THEN {"wrong-delete"} ELSE {})

\* 宿主按登记 ID 释放。
\*   none                 : 必须是**当前那条且对象还在**（compare-and-delete + 事实核对）
\*   release-by-orphan-id : 只要这个编号**曾经发过**就放行 —— 旧 ID 于是能拆掉新登记
HostRelease(id) ==
    LET orphanOk == Mutant = "release-by-orphan-id"
        issued == \E a \in Attempts : receipt[a] = id
        ok == IF orphanOk THEN (regId = id \/ issued) ELSE (Live /\ regId = id)
        wrong == ok /\ Live /\ regId # id
    IN
    /\ id \in 1..MaxReg
    /\ ok
    /\ ClearAll
    /\ UNCHANGED <<receipt, failed, seq>>
    /\ viol' = viol \union (IF wrong THEN {"wrong-delete"} ELSE {})

\* 显式空转：保证状态图没有死锁终点（TLC 会把无后继状态记成 Deadlock）。
Quiesce ==
    UNCHANGED vars

Next ==
    \/ \E a \in Attempts : Fail(a)
    \/ \E a \in Attempts : Register(a)
    \/ HostTakeover
    \/ \E a \in Attempts : Cleanup(a)
    \/ \E id \in 1..MaxReg : HostRelease(id)
    \/ Quiesce

Spec == Init /\ [][Next]_vars

\* ── 不变量 ───────────────────────────────────────────────────────────
\* ① 旧 attempt 的失败清理不得动别人的登记。
INV_SR_CLEANUP_NO_WRONG_DELETE ==
    viol \cap {"wrong-delete"} = {}

\* ② 对象没了就不许还留着能用的登记 ID / 接管回执。
INV_SR_NO_DANGLING_ID ==
    record = "absent" => (regId = 0 /\ takeover = 0)

\* ③ 回执必须指向当前那条宿主登记（否则「查得到接管、查不到服务」）。
INV_SR_NO_DANGLING_TAKEOVER ==
    takeover # 0 => (record = "present" /\ owner = "@host" /\ takeover = regId)

\* ④ 对象在就必须有编号可撤销（防「靠根本不给凭据」通过，与 F01 同一条纪律）。
INV_SR_LIVE_HAS_ID ==
    record = "present" => regId # 0

\* ⑤ 违规标签只能是具名值（枚举健全性）。
INV_SR_GHOSTS_NAMED ==
    viol \subseteq {"wrong-delete"}

====
