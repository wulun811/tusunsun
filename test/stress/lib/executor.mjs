// 最小工具执行器固件：不走完整插件装配，只把热路径需要的部件挂上。
//
// 与 test-r0-119 / test-r0-121 同款构造方式（`Object.create(默认导出)` + 字段补齐），
// 理由一致：`init()` 会起定时器、读配置、连沙箱，压测只需要"执行一次工具调用"这条路径。
import { Core } from '../../../src/core/core.js';
import ToolExecutor from '../../../plugins/tool-executor.js';

export async function buildExecutor({ workDir } = {}) {
  const core = new Core();
  // 压测输出里不要日志行：它会混进报告，也会给"被测路径"加上不该有的格式化开销
  core.log = () => {};
  if (workDir) core.setData('agent.workDir', workDir);

  const cfg = new Map();
  core.registerService('config', {
    get: (k, fb) => (cfg.has(k) ? cfg.get(k) : fb),
    set: (k, v) => { cfg.set(k, v); return true; },
  });

  const ex = Object.create(ToolExecutor);
  Object.assign(ex, {
    core,
    _tools: new Map(),
    _aliases: new Map(),
    _preHooks: [],
    _postHooks: [],
    _metrics: new Map(),
    _auditLog: new Map(),
    _cache: new Map(),
    _cacheOrder: [],
    _preferences: new Map(),
    _rateCalls: new Map(),
    _maxParallel: 2,
    _useSandbox: false,
    _timeout: 30000,
  });
  core.registerService('tool-executor', ex);

  // 能力表按工具名转发到 `_tools`，与真实装配同形（执行器只认真实能力是否注册过）
  const route = (cap, tool) => core.registerCapability(cap, {
    description: 'bench stub',
    owner: tool,
    handler: async (args) => {
      const t = ex._tools.get(tool);
      return t?.handler ? t.handler(args) : { ok: true, result: 'ran' };
    },
  });
  route('tool.bash', 'tool-bash');
  route('tool.read', 'tool-read');

  ex._tools.set('tool-bash', { handler: async () => ({ ok: true, result: 'ran' }) });
  ex._tools.set('tool-read', { handler: async () => ({ ok: true, result: 'content of file' }) });

  return { core, ex };
}
