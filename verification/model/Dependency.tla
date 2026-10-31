------------------------- MODULE Dependency -------------------------
\* 土行孙 rc.15 形式化验证 · F06 依赖与停机次序
\*
\* 这个模型回答五句「始终不许发生」，外加一句「别把系统做成不许停机」：
\*
\*   INV_F06_NO_PREMATURE_RELEASE   依赖方还没停下来（仍在跑，或者 stop() 超时卡住），
\*                                  被依赖方就**不得**被停掉 —— 停掉即等于拆了它脚下的地。
\*   INV_F06_BASIS_FAITHFUL        「凭什么有序」必须与图一致：没有一条**已装载提供者**
\*                                  的依赖边时，不许自报 basis=dependency（拿插入序冒充拓扑序）。
\*   INV_F06_NO_SILENT_UNRESOLVED  缺席的提供者必须被点名交出去，不许静默吞掉。
\*   INV_F06_NO_SILENT_CYCLE       有环时必须先报环再出顺序，不许「悄悄地跳过去」。
\*   INV_F06_NO_FAKE_STOPPED       只有真的停下来的才允许算作已停/已释放。
\*   INV_F06_STOP_ENABLED          （下界）只要还有**停得下来**的插件，停这个动作就必须
\*                                  真的还发得出来 —— 一律不停也能让上面几条全绿。
\*
\* 为什么单开一个模型而不塞进 Lifecycle：Lifecycle 问的是「锁与在途尝试」，
\* 停机在那里只是收尾阶段。F06 问的是**图**：谁依赖谁、凭什么顺序、排不出序时怎么说。
\* 混在一张表里，两边的反例互相掩盖。
\*
\* 与本模型对应的实现缺陷（本轮实测复现，此前无人报过）：
\*   `_stopLocked` 里的 for 循环**逐条独立**调用 `_stopOnePlugin`，而 `_stopOnePlugin`
\*   在 `hold_timeout` 之后只把**这一次调用**记成失败（`stop_return` / `unknown`），
\*   `plugin.state` 仍是 `running`。循环不回头检查依赖方是否真的停了，于是继续去停提供方。
\*   实测：`dependent` 超时后 state 仍为 `running`，`base` 的 `stop()` 照常被调用并变
\*   `stopped`，而 `core.stopped` 载荷里 `stopOrder = [dependent, base]` +
\*   `basis = dependency` 读起来像「按正确的顺序停好了」。
\*   —— 这正是突变体 m15 的形状。参考模型不允许它发生。
\*
\* 明确不做的事（写在这里，防止事后自夸）：
\*   · 不建模「环检测算法是否正确」：`Cyclic` 由 Shape 给出，模型只问「有没有报出来」。
\*     检测算法本身由实现轨的 F06 重放判据 ④ 与 `computeStopOrder` 的单测负责。
\*   · 不建模停机失败后的**外部**效果（插件留下的半截状态）。
\*   · 不建模进程隔离，也不建模「调用方等待有界」（那是 F08，Lifecycle.tla 已管）。
\*     特别地：**core.stop() 有界返回 ≠ 提供方已被释放**。本模型只问后者。
\*
\* 与 F08 的关系（必须写清，否则两边的结论会被互相抵消）：
\*   F08 允许「某个 handler 永不返回时，调用方仍然有界地拿回答复」。
\*   它**不**因此允许「在依赖方还没停的时候把提供方拆掉」。两件事各自成立，
\*   不存在「为了有界返回只好牺牲顺序」这种交换 —— 有界返回不必以释放为代价。
\*
\* 范围：三个 Shape 共用同一份动作定义，只换图，不换语义：
\*   "chain"             a↔c 成环、b→a 已装载、b→ghost 缺席（链 + 环 + 缺席同时在）
\*   "no-live"            只有 b→ghost 一条，且 ghost 不在 —— **一条活的依赖边都没有**
\*   "two-cycles-linked"   a↔b 与 c↔d 两个独立环，再加一条 c→a：两个 SCC 之间的**真实**
\*                       依赖边（专家 R15-01 的形状：它是依赖，不是环内互等，不得豁免）
\*
\* 突变体是**故意写坏**的模型，每个只改一处语义；找不到反例就是模型对该偏差不敏感。

EXTENDS Naturals, FiniteSets

CONSTANTS
    Mutant,   \* "none" | 五个故意写坏之一，见 MUTANTS 注释
    Shape     \* "chain" | "no-live" —— 只换图。cfg 里不能写元组集合（TLC 只认简单字面量），
              \* 所以图定义留在这里；三份 cfg 只改 Mutant / Shape，图永远是这同一份定义。

VARIABLES
    st,                 \* [Plugins -> "running" | "stopped" | "stuck"]
                        \*   "stuck" = stop() 到点没返回，**仍可能在跑** —— 不是停好了
    released,           \* SUBSET Plugins —— 已经交还了资源（= 它的服务真的没了）
    basis,              \* "none"（还没排过序）| "dependency" | "insertion"
    reportedUnresolved, \* SUBSET Deps —— 点名交出去的缺席边
    reportedCycles,     \* BOOLEAN —— 环有没有被具名报出
    ghost               \* 幽灵：已发生过的违规，取 {"premature","fake_basis",
                        \*   "silent_unresolved","silent_cycle"} 的子集。不属实现状态。

vars == <<st, released, basis, reportedUnresolved, reportedCycles, ghost>>

\* ── 图（由 Shape 决定）─────────────────────────────────────────────────
Plugins ==
    CASE Shape = "two-cycles-linked" -> {"a", "b", "c", "d"}
      [] OTHER                       -> {"a", "b", "c"}

\* 依赖边 <<依赖方, 提供方>>。ghost 不是插件，"b 依赖 ghost" 就是缺席提供者。
Deps ==
    CASE Shape = "chain"   -> {<<"a","c">>, <<"b","a">>, <<"b","ghost">>, <<"c","a">>}
      [] Shape = "no-live" -> {<<"b","ghost">>}
      \* 两个独立的环（a↔b、c↔d）之间**只有一条**边 c→a。
      [] Shape = "two-cycles-linked"
           -> {<<"a","b">>, <<"b","a">>, <<"c","d">>, <<"d","c">>, <<"c","a">>}
      [] OTHER             -> {}

\* 已装载的插件集合（= Plugins）。写成一个名字，是为了让"缺席"这个判据只有一处定义。
Provided == Plugins

\* 强连通分量编号（图的事实）。**豁免只能发生在同一个分量里**：
\* 「两个节点各自在某个环里」不是同一个条件 —— 两个不相干的环之间那条真实依赖边
\* 会被一起豁免（专家 R15-01 的实测形状）。单例也必须是各自不同的编号，
\* 否则“同分量”会把两个互不相干的节点也算成互等。
Comp ==
    CASE Shape = "chain"
           -> [p \in Plugins |-> IF p = "a" \/ p = "c" THEN 1 ELSE 2]
      [] Shape = "two-cycles-linked"
           -> [p \in Plugins |-> IF p = "a" \/ p = "b" THEN 1 ELSE 2]
      [] OTHER
           -> [p \in Plugins |-> IF p = "a" THEN 1 ELSE IF p = "b" THEN 2 ELSE 3]

\* 处在某个**多于一个成员**的分量里（= 真的在环里）。
Cyclic == {p \in Plugins : \E q \in Plugins : q # p /\ Comp[p] = Comp[q]}

(* ── 突变体（本仓新增 5 条；m15 对应当前实现的真实形状）─────────────────────
   m15-release-under-stuck-dependent  依赖方 stop 超时（stuck，仍在跑）后，
                                      提供方照停 —— 即 `_stopLocked` 的 for 循环
                                      不回头检查依赖方是否**真的**停了
                                                                → 撞 INV_F06_NO_PREMATURE_RELEASE
   m16-insertion-as-topology          没有任何已装载提供者的依赖边，却自报
                                      basis=dependency（拿插入序冒充拓扑序）
                                                                → 撞 INV_F06_BASIS_FAITHFUL
   m17-swallow-unresolved             缺席的提供者被静默吞掉，不交出去
                                                                → 撞 INV_F06_NO_SILENT_UNRESOLVED
   m18-swallow-cycle                  环不报，直接跳过出顺序
                                                                → 撞 INV_F06_NO_SILENT_CYCLE
   m19-deny-all-stop                  停机一律发不出去（"永远别停"也能让上面全绿）
                                                                → 撞 INV_F06_STOP_ENABLED
   m21-cross-scc-exemption            环豁免写成“出现在任意一个环里”而不是“同一个 SCC”：
                                      两个环之间那条真实依赖边被一起豁免，依赖方还在跑
                                      就把提供方停了 —— rc.15 实现的真实形状（R15-01）
                                                                → 撞 INV_F06_NO_PREMATURE_RELEASE
   ─────────────────────────────────────────────────────────────────────── *)

IsM15 == Mutant = "m15-release-under-stuck-dependent"
IsM16 == Mutant = "m16-insertion-as-topology"
IsM17 == Mutant = "m17-swallow-unresolved"
IsM18 == Mutant = "m18-swallow-cycle"
IsM19 == Mutant = "m19-deny-all-stop"
IsM21 == Mutant = "m21-cross-scc-exemption"

\* ── 图上的判据 ───────────────────────────────────────────────────────
\* 依赖 p 的、且**真的装载了**的插件。缺席的依赖方不是边：它不在表里，也没人会因为
\* 它而被拦住（停机不能因为「一个不在的东西依赖它」就排不出序）。
DependentsOf(p) == {q \in Plugins : <<q, p>> \in Deps}

\* 缺席的边：提供方根本没装载。
MissingEdges == {e \in Deps : e[2] \notin Provided}

\* 图上**真的存在**的边（两端都在）。
LiveEdges == {e \in Deps : e[2] \in Provided}

\* 依赖方全都停好了。判据是 `= "stopped"`：`"stuck"` **不算** ——
\* 「stop() 到点没返回」恰恰是「它可能还在用 p 的服务」最危险的那一格。
\*
\* 环内豁免是**图的事实**，不是"报没报"的后果：p 与 q 互为依赖时，要求 q 先停
\* 与要求 p 先停同时成立，谁也动不了 —— 停机就会挂住。所以环内边不进 TruthReady。
\* 环**外**依赖方（本例的 b→a）不在环里，没有任何理由被连带豁免。
\*
\* 这一条撞过两次，都记在 sensitivity_audit 里：
\*   ① 第一版写成 `p \in Cyclic \/ Ready(p)`，把"a 在环里"当成"a 的所有依赖方
\*      都可以不管"，参考模型自己在 StopOk("a") 上就撞了（b 还 running，a 已 released）；
\*   ② 第二版把环的豁免挂到 `reportedCycles` 上，于是"环没报"变成一个**前置条件**，
\*      谁也停不了、谁都碰不到违规 —— m18 因此存活。豁免必须只看图。
\*
\* **truth 与 guard 必须分成两个算子**：
\*   TruthReady  只读图与事实，**不含任何突变体谓词** —— 它定义"什么叫违规"；
\*   Ready       是守卫，含 IsM15 —— 它定义"动作允不允许发"。
\* 合成一个时，幽灵判据会跟着守卫一起被放宽（m15 永远"合规"）。
TruthReady(p) ==
    \A q \in DependentsOf(p) :
        \/ st[q] = "stopped"
        \/ Comp[p] = Comp[q]

\* m21 = rc.15 的实现："两个节点各自在某个环里"就豁免。它与 TruthReady 的差别
\* **只在两个分量之间那条边**上，所以模型必须真有两个环才看得出它是错的。
TruthReadyAnyCycle(p) ==
    \A q \in DependentsOf(p) :
        \/ st[q] = "stopped"
        \/ (p \in Cyclic /\ q \in Cyclic)

\* m15 把守卫整个豁免掉 —— 那不是"环的特例"，是**所有**节点都不查依赖方。
Ready(p) == IsM15 \/ (IF IsM21 THEN TruthReadyAnyCycle(p) ELSE TruthReady(p))

\* 环成员必须先被具名报出，才允许出顺序。非环成员不受此约束。
GuardCycle(p) == IsM18 \/ p \notin Cyclic \/ reportedCycles

\* 这一刻 p 停不停得下来（= 两个停动作的公共前置）。
CanStop(p) ==
    /\ basis # "none"                    \* 还没排过序，谈不上"按顺序停"
    /\ st[p] = "running"
    /\ Ready(p)
    /\ GuardCycle(p)
    /\ ~IsM19

\* ── 初始化 ───────────────────────────────────────────────────────────
Init ==
    /\ st = [p \in Plugins |-> "running"]
    /\ released = {}
    /\ basis = "none"
    /\ reportedUnresolved = {}
    /\ reportedCycles = FALSE
    /\ ghost = {}

(* ── 停机开始：排一次序，并如实交出"凭什么" ────────────────────────────
   参考模型的 basis：图上**真有一条活边**才算 dependency，否则只能是 insertion。
   注意判据用的是 LiveEdges（两端都在），不是 Deps —— 只有一条指向缺席提供者的边时，
   那不是"有依赖信息"，那是"依赖信息不全"，仍然只能是 insertion。
   m16 无条件报 dependency。                                                  *)
Plan ==
    LET faithful == IF LiveEdges = {} THEN "insertion" ELSE "dependency"
        claimed == IF IsM16 THEN "dependency" ELSE faithful
        \* 缺席边必须**全部**点名交出去；m17 一条也不交。
        unr == IF IsM17 THEN {} ELSE MissingEdges
        badBasis == claimed # faithful
        \* 该交的没交（或交的比该交的少）= 静默吞掉。判据是"交了的是不是该交的全部"，
        \* 不是"交没交过" —— 后者在只有一条缺席边时会被"交了一条"蒙过去。
        silenced == unr # MissingEdges
    IN
    /\ basis = "none"
    /\ basis' = claimed
    /\ reportedUnresolved' = unr
    /\ reportedCycles' = reportedCycles
    /\ st' = st
    /\ released' = released
    /\ ghost' = ghost
        \union (IF badBasis THEN {"fake_basis"} ELSE {})
        \union (IF silenced THEN {"silent_unresolved"} ELSE {})

\* ── 停一个插件：成功了 ───────────────────────────────────────────────
\* 停下来 ⇒ 它提供的服务随之交还 ⇒ released。这两件事**同时**发生，
\* 所以「released 里出现了 p」等价于「p 真的停好了」，不可能有第三种解释。
StopOk(p) ==
    LET premature == ~TruthReady(p)
        silentCycle == (p \in Cyclic) /\ ~reportedCycles
    IN
    /\ CanStop(p)
    /\ st' = [st EXCEPT ![p] = "stopped"]
    /\ released' = released \union {p}
    /\ ghost' = ghost
        \union (IF premature THEN {"premature"} ELSE {})
        \union (IF silentCycle THEN {"silent_cycle"} ELSE {})
    /\ UNCHANGED <<basis, reportedUnresolved, reportedCycles>>

\* ── 停一个插件：stop() 到点没返回 ─────────────────────────────────────
\* 环境允许这件事发生（合同 §1 前提 5）。**它不释放任何东西**：
\* 「调用方等待有界」不等于「这个插件停了」。这正是 F08 与 F06 的分界，
\* 也是本模型必须有 `stuck` 这个取值、而不能只有 stopped/running 的原因。
StopStuck(p) ==
    /\ CanStop(p)
    /\ st' = [st EXCEPT ![p] = "stuck"]
    /\ ghost' = ghost
        \union (IF (p \in Cyclic) /\ ~reportedCycles THEN {"silent_cycle"} ELSE {})
    /\ UNCHANGED <<released, basis, reportedUnresolved, reportedCycles>>

\* ── 报环 ─────────────────────────────────────────────────────────────
\* 只有确实存在环时才谈得上"报环"；没有环却报环是另一种代签，所以前置里要求 Cyclic # {}。
ReportCycle ==
    /\ Cyclic # {}
    /\ ~reportedCycles
    /\ reportedCycles' = TRUE
    /\ UNCHANGED <<st, released, basis, reportedUnresolved, ghost>>

\* ── 收敛点 ───────────────────────────────────────────────────────────
\* "没有别的事可做" = 排过序了，且每个还 running 的插件此刻都停不下来。
Quiesce ==
    /\ basis # "none"
    /\ \A p \in Plugins : ~CanStop(p)
    /\ UNCHANGED <<st, released, basis, reportedUnresolved, reportedCycles, ghost>>

Next ==
    \/ Plan
    \/ \E p \in Plugins : StopOk(p)
    \/ \E p \in Plugins : StopStuck(p)
    \/ ReportCycle
    \/ Quiesce

Spec == Init /\ [][Next]_vars

(* ── 安全性质 ─────────────────────────────────────────────────────────── *)
\* F06①：依赖方还没停好（仍在跑 / 卡住），就不许把提供方停掉。
\* 这是本模型的主结论，也是 m15 撞的那一条 —— 对应当前实现的真实形状。
INV_F06_NO_PREMATURE_RELEASE ==
    "premature" \notin ghost

\* F06②：basis 必须与图一致。没有活的依赖边却报 dependency = 拿插入序冒充拓扑序。
INV_F06_BASIS_FAITHFUL ==
    "fake_basis" \notin ghost

\* F06③：缺席的提供者必须被点名交出去。
INV_F06_NO_SILENT_UNRESOLVED ==
    "silent_unresolved" \notin ghost

\* F06④：环必须先报出来再出顺序。
INV_F06_NO_SILENT_CYCLE ==
    "silent_cycle" \notin ghost

\* F06⑤：只有真停下来的才允许被算成已释放。
\* 写成状态谓词而不是靠构造保证，是为了让「stuck 也算停成」这种改法真的被撞到。
INV_F06_NO_FAKE_STOPPED ==
    released \subseteq {p \in Plugins : st[p] = "stopped"}

\* ⑥ 幽灵变量只能是具名集合（沿用 Ownership 的同一条纪律：
\*    TLA+ 里 `=` 比 `\/` 优先，写错一个赋值会让变量变成 null 而 TLC 不报错）。
INV_F06_GHOSTS_NAMED ==
    ghost \subseteq {"premature", "fake_basis", "silent_unresolved", "silent_cycle"}

(* ── 下界性质：正例必须仍在（沿用 Ownership m10/m11 的纪律）────────────────
   专家回函：「即使所有冒名不能释放都绿，也应判 NO-GO —— 那只是把可演化运行时
   变成『不许卸载』的系统。」停机同理：一律不停能让上面五条全部为真。

   这一条问的是「此刻还发不发得出来」，所以用 `ENABLED`，不用「有没有发生过」。
   Ownership 那边踩过三次（<>released / IsM10 \/ … / 只看句柄在不在），
   这里不再重走：只有 ENABLED 同时挡住「不许发生」与「从没发生」。                *)
\* 只要还有**按图确实停得下来**的插件，停机动作就必须真的还发得出来。
\*
\* 左半边故意**不**读 IsM15/IsM18/IsM19，也不走 GuardDependents/GuardCycle ——
\* 那两个算子含突变体谓词，一读就等于让突变体给自己开后门
\* （Ownership 那边正是这么让 m10 活过来的）。左半边只读**纯图事实**：
\* Ready(p) 与"环报没报"。右半边问"动作发不发得出"。两者一分离，"一律不停"就不再是安全。
INV_F06_STOP_ENABLED ==
    (basis # "none") =>
      (((\E p \in Plugins : st[p] = "running" /\ Ready(p) /\ (p \notin Cyclic \/ reportedCycles))
          => (\E p \in Plugins : ENABLED StopOk(p) \/ ENABLED StopStuck(p))))

====
