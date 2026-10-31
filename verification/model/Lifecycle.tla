------------------------------- MODULE Lifecycle -------------------------------
\* 土行孙 rc.15 形式化验证试点 · 生命周期 / 在途尝试 / 纪元 / 停机
\*
\* 这个模型回答四句「始终不许发生」，而不是替实现背书：
\*
\*   F03  在途尝试还有效时，不允许任何超时把它占用的资源 lease 放掉。
\*   F04  同一生命周期 key 同一时刻最多一个**真实**临界区在跑。
\*        —— 注意「锁以为谁在持有」（holders）与「真的谁在跑」（running）是两件事；
\*        两者混成一个变量，H7 那类 bug 在模型里就不可见。
\*   F05  旧代装配的异步提交不允许写进新代的登记。
\*   F08  停机期限到了只允许对**调用方**说「未确知」，不允许说「已停」；
\*        「停调用返回」不等于「插件真的停了」（handlerDone 只归环境写）。
\*
\* 明确不做的事（写在这里，防止事后自夸）：
\*   · 不建模 F01（Ownership 需要登记身份与 token 铸造者，属 Ownership.tla）；
\*   · 不建模 F02/F06/F07；
\*   · 不把 TLC 的 NO ERROR 叫作「已验证」—— 状态词见 verification/contracts。
\*
\* 范围取自专家合同 §3：两插件、两个 waiter、两代 epoch、一次锁等待超时、
\* 一次停机期限；StopFault 让「handler 永不返回」成为**合法环境**，不是错误。
\*
\* 突变体不是一个修订版，而是一组**故意写坏**的模型：每个 Mutant 值只改一处语义。
\* 若某个突变体找不到反例，说明模型对该 bug 不敏感（= 模型是空的），不是模型通过。

EXTENDS Naturals, FiniteSets

CONSTANTS
    Plugins,      \* 插件名集合，如 {"A", "B"}
    Waiters,      \* 等锁者集合，如 {"W1", "W2"}
    MaxEpoch,     \* epoch 上界：TLA+ 的 Nat 无界，不设界 TLC 会跑不完
    StopFault,    \* TRUE = 环境允许 stop handler 永不返回（专家 §3 的「无公平性」分支）
    Mutant        \* "none" | 四个故意写坏之一，见 MUTANTS 注释

ASSUME Plugins # {} /\ Waiters # {}

\* 插件与等锁者共用一张「谁此刻在排队」的表：直接进入者与排队者在同一张表里，
\* 不去分两张表 —— 分开就会出现「A 在表一、W1 在表二」而两边都以为锁是空的。
Actors == Plugins \cup Waiters

VARIABLES
    holders,      \* SUBSET Plugins —— 锁的记账：它以为谁在持有
    running,      \* SUBSET Plugins —— 真实事实：谁真的在临界区里
    leased,       \* BOOLEAN —— 在途尝试此刻是否仍持有资源租约（F03）
    attempt,      \* "idle" | "inflight" | "settled"
    waiter,       \* [Actors -> "idle" | "queued" | "timedout" | "granted"]
    epoch,        \* 当前代
    asmEpoch,     \* 本次装配开始时取得的代
    asmPending,   \* 是否有未提交的装配
    applied,      \* 登记最后一次被子写到哪一代（0 = 从没写过）
    staleWrite,   \* 幽灵标记：旧代提交真的写进去了（F05 的检测器）
    phase,        \* 0 running | 1 stopping | 2 stopped
    stopClaim,    \* 0 none | 1 unresolved | 2 stopped —— Core 对**调用方**的答复
    handlerDone   \* BOOLEAN —— 环境事实：handler 真的返回了。模型动作**不许**写它

vars == <<holders, running, leased, attempt, waiter, epoch, asmEpoch, asmPending,
          applied, staleWrite, phase, stopClaim, handlerDone>>

(* ── 突变体（专家合同 §4 + §2 的禁止写法）─────────────────────────────────
   m1-timeout-releases-lease      WaiterTimeout 顺手清掉真实 attemptLease   → 撞 F03
   m2-late-commit-without-epoch   旧代提交不看 epoch guard                  → 撞 F05
   m3-waiter-timeout-releases-lock 等锁超时者释放了别人的锁                 → 撞 F04（H7）
   m4-stop-deadline-claims-stopped 期限到了就宣称「已停」                    → 撞 F08（§2 禁止写法二）
   m5-no-stop-deadline            停机根本没有期限，只有无限等                → TLC 报死锁（H8 修前形状）
   ─────────────────────────────────────────────────────────────────────── *)

IsM1 == Mutant = "m1-timeout-releases-lease"
IsM2 == Mutant = "m2-late-commit-without-epoch"
IsM3 == Mutant = "m3-waiter-timeout-releases-lock"
IsM4 == Mutant = "m4-stop-deadline-claims-stopped"
IsM5 == Mutant = "m5-no-stop-deadline"

Init ==
    /\ holders = {}
    /\ running = {}
    /\ leased = FALSE
    /\ attempt = "idle"
    /\ waiter = [a \in Actors |-> "idle"]
    /\ epoch = 1
    /\ asmEpoch = 1
    /\ asmPending = FALSE
    /\ applied = 0
    /\ staleWrite = FALSE
    /\ phase = 0
    /\ stopClaim = 0
    /\ handlerDone = FALSE

\* 直接进入：此刻锁空着，且这个名字没有在排队。
\* 注意这里**不**看 attempt：真实 runExclusive 也不看——它只看队列 Map。
\* 加上「attempt = idle」会把并发进入人为地串行化，于是 m3（超时者释放别人的锁）
\* 永远撞不上不变量。第一版就是这么写的，m3 真的活了下来（见 reports/model-check.json 的
\* sensitivity_audit）：模型自己也要通过「被突变体杀死」这一关。
Enter(p) ==
    /\ holders = {}
    /\ p \notin running
    /\ waiter[p] = "idle"
    /\ phase = 0
    /\ holders' = {p}
    /\ running' = running \cup {p}
    /\ leased' = TRUE
    /\ attempt' = "inflight"
    /\ waiter' = [waiter EXCEPT ![p] = "granted"]
    /\ UNCHANGED <<epoch, asmEpoch, asmPending, applied, staleWrite,
                   phase, stopClaim, handlerDone>>

\* 排队：锁被别人拿着。排队这件事本身**不产生**任何持有。
Enqueue(w) ==
    /\ holders # {}
    /\ waiter[w] = "idle"
    /\ phase = 0
    /\ waiter' = [waiter EXCEPT ![w] = "queued"]
    /\ UNCHANGED <<holders, running, leased, attempt, epoch, asmEpoch, asmPending,
                   applied, staleWrite, phase, stopClaim, handlerDone>>

\* 队首拿到锁。
EnterFromQueue(w) ==
    /\ holders = {}
    /\ w \notin running
    /\ waiter[w] = "queued"
    /\ phase = 0
    /\ holders' = {w}
    /\ running' = running \cup {w}
    /\ leased' = TRUE
    /\ attempt' = "inflight"
    /\ waiter' = [waiter EXCEPT ![w] = "granted"]
    /\ UNCHANGED <<epoch, asmEpoch, asmPending, applied, staleWrite,
                   phase, stopClaim, handlerDone>>

\* 等锁超时：**只**退出自己的等待资格。
\*   m1 额外把 lease 放了 —— 那是在别人的在途尝试上签字。
\*   m3 额外把 holders 清空 —— 那等于宣布「这条 key 现在没人持有」。
LockWaitTimeout(w) ==
    /\ waiter[w] = "queued"
    /\ waiter' = [waiter EXCEPT ![w] = "timedout"]
    /\ holders' = IF IsM3 THEN {} ELSE holders
    /\ leased' = IF IsM1 THEN FALSE ELSE leased
    /\ UNCHANGED <<running, attempt, epoch, asmEpoch, asmPending, applied, staleWrite,
                   phase, stopClaim, handlerDone>>

\* 正常结束：真的离开临界区，锁回到空。
Exit(p) ==
    /\ p \in running
    /\ running' = running \ {p}
    /\ holders' = {}
    /\ leased' = FALSE
    /\ attempt' = "idle"
    /\ waiter' = [waiter EXCEPT ![p] = "idle"]
    /\ UNCHANGED <<epoch, asmEpoch, asmPending, applied, staleWrite,
                   phase, stopClaim, handlerDone>>

BeginAssembly ==
    /\ phase = 0
    /\ ~asmPending
    /\ asmEpoch' = epoch
    /\ asmPending' = TRUE
    /\ UNCHANGED <<holders, running, leased, attempt, waiter, epoch, applied,
                   staleWrite, phase, stopClaim, handlerDone>>

\* 提交装配：只有「装配时取得的代 == 当前代」才允许写登记。
NewApplied ==
    IF IsM2 \/ (asmEpoch = epoch) THEN asmEpoch ELSE applied

NewStale ==
    IF IsM2 /\ (asmEpoch # epoch) THEN TRUE ELSE staleWrite

CommitAssembly ==
    /\ asmPending
    /\ asmPending' = FALSE
    /\ applied' = NewApplied
    /\ staleWrite' = NewStale
    /\ UNCHANGED <<holders, running, leased, attempt, waiter, epoch, asmEpoch,
                   phase, stopClaim, handlerDone>>

\* 开始停机：代加一。旧代此刻起就是旧代。
BeginStop ==
    /\ phase = 0
    /\ epoch < MaxEpoch
    /\ phase' = 1
    /\ epoch' = epoch + 1
    /\ UNCHANGED <<holders, running, leased, attempt, waiter, asmEpoch, asmPending,
                   applied, staleWrite, stopClaim, handlerDone>>

\* handler 真的返回了（环境动作；StopFault 时永不发生）。
StopHandler ==
    /\ phase = 1
    /\ ~StopFault
    /\ handlerDone' = TRUE
    /\ stopClaim' = 2
    /\ phase' = 2
    /\ UNCHANGED <<holders, running, leased, attempt, waiter, epoch, asmEpoch,
                   asmPending, applied, staleWrite>>

\* 停机期限到了：对调用方必须给一个**具名**答复。
\* 参考模型给 "unresolved"，并且**不动** handlerDone。
\* m4 冒充「已停」—— 这正是专家 §2 禁止的写法二。
StopDeadline ==
    /\ phase = 1
    /\ stopClaim = 0
    /\ ~IsM5
    /\ stopClaim' = IF IsM4 THEN 2 ELSE 1
    /\ phase' = IF IsM4 THEN 2 ELSE phase
    /\ UNCHANGED <<holders, running, leased, attempt, waiter, epoch, asmEpoch,
                   asmPending, applied, staleWrite, handlerDone>>

\* 停机已经对调用方给出具名答复之后，系统确实没有别的事可做。
\* 这不是「随便允许停住」：`phase = 1 /\ stopClaim = 0`（问了却没答）**不在**里面 ——
\* 那种状态若不可离开，就是 H8：核心永远不返回。TLC 会把它报成 deadlock，
\* 这正是 m5（把停机做成无期限）应当失败的形状。
Quiesce == (phase = 2 \/ (phase = 1 /\ stopClaim # 0)) /\ UNCHANGED vars

Next ==
    \/ \E p \in Plugins : Enter(p)
    \/ \E w \in Waiters : Enqueue(w)
    \/ \E w \in Waiters : EnterFromQueue(w)
    \/ \E w \in Waiters : LockWaitTimeout(w)
    \/ \E p \in Plugins : Exit(p)
    \/ BeginAssembly
    \/ CommitAssembly
    \/ BeginStop
    \/ StopHandler
    \/ StopDeadline
    \/ Quiesce

\* 公平性只加在「期限」上，因为期限是宿主定时器给的，不是环境配合：
\* 真实系统里 setTimeout 一定会触发。handler 是否返回则**不做**公平假设 ——
\* StopFault=TRUE 时它永远不返回，这是合法的环境行为（专家 §3）。
Spec == Init /\ [][Next]_vars /\ WF_vars(StopDeadline)

(* ── 安全性质 ─────────────────────────────────────────────────────────── *)
\* F04：真实临界区至多一个。用 running 而不是 holders —— 记账可以骗人，事实不行。
INV_F04_MUTEX == Cardinality(running) =< 1

\* F03：在途尝试必须仍有租约。
INV_F03_LEASE == (attempt = "inflight") => leased

\* F05：没有旧代提交写进登记。staleWrite 是幽灵检测器（与专家 POC 的 invalidCommit 同法）。
INV_F05_NO_STALE_WRITE == ~staleWrite

\* F08：说「已停」就必须真的有 handler 返回过。
INV_F08_NO_FAKE_STOPPED == (stopClaim = 2) => handlerDone

(* ── 限时性质 ─────────────────────────────────────────────────────────── *)
\* 进了 stopping 就一定给得出具名答复（依赖 WF_vars(StopDeadline)）。
\* 这条**不能**推出 handler 已停：它只说「调用方不会永远没有答案」。
StopBounded == (phase = 1) ~> (stopClaim # 0)

=============================================================================
