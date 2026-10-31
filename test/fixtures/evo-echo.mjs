// E4 演化成本试验用的**纯外围插件**：新开一个能力，不碰 `src/core/`。
//
// 专家原文 §10 P5：
//   「E4 演化成本试验：**完全新增一个 `evo.echo` 插件，不修改 Core**；让它 eager、lazy、
//     重载、卸载；加入受限能力、动作回执、场景切换；记录每次变更涉及的源文件／核心行数与回归范围。」
//
// 这个文件就是那个插件。它被 `test/unit/test-evo-echo-evolution-cost.test.mjs` 真实装载、
// 重载、卸载，并被断言"每一步之后 `src/core/` 的总行数一个字都没变"。
//
// 顺带说明它为什么长这样：
//   · 能力用 `evo.echo` 前缀而不是 `tool.*` —— 本试验要证明的是"**任意**新能力都不必改 Core"，
//     如果只测 `tool.*`，那可能只是走了内核已有的工具通道，证明不了外围可演化。
//   · 带 `permissions`：受限能力必须在真实副作用入口生效（I-02），不能只在注释里声称。
//   · 回执用 `plugins/_lib/action-receipt.mjs`（既有公共设施），不是新写一套 ——
//     否则"演化成本"会把"重造一个回执系统"也算进去，那不是本试验要测的。

class EvoEcho {
  name = 'evo-echo';
  version = '1.0.0';
  description = 'E4 演化成本试验插件：只回答它收到的内容，用于验证新增能力不需要改内核';
  permissions = ['evo.echo'];
  provides = [{ name: 'evo.echo', removable: true }];

  async init(core) {
    this.core = core;
    // 用**进程级**计数器而不是实例字段：重载会换一个新实例，
    // 实例字段永远从 1 开始，根本分不清"重新 init 过"与"还是老实例没动"。
    // 这正是本项目反复记的那条教训——判据必须能分辨它声称要分辨的东西。
    globalThis.__evoInitCount = (globalThis.__evoInitCount || 0) + 1;
    this.initCount = globalThis.__evoInitCount;

    core.registerCapability('evo.echo', {
      description: '把收到的内容原样回声（E4 试验用）',
      owner: 'evo-echo',
      // 受限能力：要求调用方必须是受信主体。这条不是装饰 ——
      // 试验要证明"新能力可以自带约束"，而约束必须由内核在入口执行（I-02）。
      permissions: { require_identity: true, scope: 'read' },
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      handler: async (args) => {
        this.callCount = (this.callCount || 0) + 1;
        return { echoed: args.text, initCount: this.initCount, callCount: this.callCount };
      },
    });
  }

  async start() {
    this.started = true;
  }

  async stop() {
    this.started = false;
  }
}

export default new EvoEcho();
