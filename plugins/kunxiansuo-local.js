// kunxiansuo-local.js — 捆仙索本地安全（无外部诊断服务依赖）
// 包含：脊髓层黑名单 + 路径边界 + 熔断器 + 速率限制 + 结果脱敏 + 写前必读
// **不包含**（且是刻意的，不是遗漏）：
//   · 戒尺（锚点防篡改）—— 它校验的是"捆仙索自己有没有被改过"。本项目经常升级、
//     自己就在改这些文件，锚点哈希必然频繁变化：要么每次升级都重签锚点（多一道容易
//     忘记的手续），要么把哈希当摆设。开发版本里它是纯摩擦，故不随包、不启用。
//   · 照妖镜（声誉评估）—— 依赖外部诊断服务的只读库（`mingRo`），开源版没有外部诊断服务。
//     强行创建会在每次工具调用时抛 TypeError，故整块移除而不是"留着但不接"。
//   · 外部诊断服务诊断处方 / P0 推送 / 探针桥 —— 外部扩展组件范畴。

import { join } from 'node:path';
import { LocalFence } from './_lib/kunxiansuo/local-fence.js';
import { DiagnosticCard } from './_lib/kunxiansuo/diagnostic-card.js';
import { FileSystemGuard } from './_lib/kunxiansuo/file-guard.js';
import { RetryChainTracker } from './_lib/kunxiansuo/retry-chain.js';
import { setFence, removeFence, fenceStatus } from './tool-executor.js';

class KunxiansuoLocal {
  name = 'kunxiansuo-local';
  version = '0.7.0';
  provides = [
    { name: 'kunxiansuo.local', type: 'service' },
    // R0-156：`tool.fence` 是**能力**（本插件的方法面），不是服务；没标 type 会被当成 service。
    { name: 'tool.fence', type: 'capability' },
  ];

  async init(core) {
    this.core = core;
    this.localFence = new LocalFence(core);
    this.localFence._fsGuard = new FileSystemGuard(
      core.get('kunxiansuo.local.fsguard')
    );
    this.chainTracker = new RetryChainTracker(
      core.get('kunxiansuo.local.retry.max') || 3,
      core.get('kunxiansuo.local.retry.window') || 10000,
    );
    core.registerService('kunxiansuo.local', this);

    // R0-119 缺陷 1（实测）：此前**只注册服务、不接管工具护栏** —— `setFence` 从未被调用，
    // 于是把 `kunxiansuo-local` 写进场景只会得到一个"存在但不生效"的服务：
    // 危险命令判据、路径边界、熔断、限流全部不跑，而 `core.getService('kunxiansuo.local')`
    // 却返回一个活对象（"装了但没接线"）。开源版没有 `kunxiansuo-bundle` 来替它接线，
    // 所以这条必须由 local 版自己接。
    // R0-125（G0-2）：装配时带 **owner + core**，拿回 token。此后：
    //   · 只摘得掉自己装的这一份（`removeFence({ owner })`），别的 Core 的护栏不受影响；
    //   · 两个 Core 同进程时各解析各的，不会互相覆盖；
    //   · `fenceStatus(core)` 能如实回答"这个内核现在到底有没有护栏、是谁的"。
    // 修前这里是裸 `setFence(this)`：模块级单值，后装配的覆盖前一个，任意一方 stop 全清。
    const inst = setFence(this, { owner: 'kunxiansuo-local', core });
    this._fenceToken = inst.token;
    this._fenceInstalled = true;

    // 同上：`local-fence` 的"读前必读"靠 `markRead()` 记状态，而开源版没有任何地方调用它
    // ⇒ 开启护栏后**第一次 `tool-write` 必然被 WRITE_BEFORE_READ 拦死**（实测已复现）。
    // bundle 版用 postHook 接线，这里用同一套机制补上。
    // R0-121：只有**读成功**才记已读。执行器把成功标志作为第 7 参传入；失败的读
    // （超时/文件不存在/权限）没让模型看到内容，记成"已读"等于给写前必读开后门。
    // 兼容性：拿不到第 7 参（undefined）按成功处理，不影响旧调用方。
    const toolExec = core.getService('tool-executor');
    if (toolExec?.registerPostHook) {
      toolExec.registerPostHook((toolName, args, _result, sessionId, _chainId, _duration, ok) => {
        if (ok === false) return;
        if (toolName !== 'tool-read' || !args?.path) return;
        // R0-124：读记录的绝对路径必须与 `preCheck` 判"写前必读"时用的是**同一个根**，
        // 否则两会话各自在自己的目录里读写同名的 `a.txt` 时会互相误判
        const workDir = core.getService?.('workspace')?.root?.(sessionId)
          || core.getData('agent.workDir') || core.get('agent.workDir') || process.cwd();
        const abs = args.path.startsWith('/') ? args.path : join(workDir, args.path);
        this.localFence.markRead(sessionId, abs);
      }, 'kunxiansuo-local', 50);
    }

    // R0-120：照妖镜整块移除（原 R0-119 只是"没有 mingRo 就不启用"）。
    // 理由：它的全部输入都来自外部诊断服务的表（`events` / `diagnoses_<year>`），开源版没有那个库，
    // 留着只是一个永远不启用的分支 + 一个容易误导人的配置键。声誉评估属外部诊断服务能力。
  }

  async preCheck(tool, args, sessionId, chainId, context) {
    // 注意：执行器把 context 作为第 5 个参数传入（`this.core?._fenceContext` 或软闸确认载荷），
    // local-fence 的 ctx 走第 6 个参数。此处的 context 原样透传，不吞掉。
    const localResult = this.localFence.preCheck(tool, args, sessionId, chainId, null, context);
    if (!localResult.ok) {
      return { ok: false, result: DiagnosticCard.create({
        code: localResult.code || 'UNKNOWN', tool,
        reason: localResult.reason,
        alternatives: localResult.alternatives || [],
        hint: localResult.hint || '',
        retryable: localResult.retryable !== false,
        chainId, retryCount: 0, context, args,
      }) };
    }
    return { ok: true };
  }

  async postCheck(tool, result, duration, ok, sessionId, chainId) {
    return this.localFence.postCheck(tool, result, duration, ok, sessionId, chainId);
  }

  /**
   * R0-125：**真实装配状态**（不是"插件在场景清单里"）。
   * `installed:true` 只在这个内核确实解析得到本护栏时为真；否则说明装配失败/已被替换，
   * 调用方（Cell 启动、/health、诊断）据此拒绝宣称"护栏已生效"。
   */
  fenceStatus() {
    const st = fenceStatus(this.core);
    return { ...st, mine: st.owner === 'kunxiansuo-local' };
  }

  async stop() {
    if (this._fenceInstalled) {
      // 带 owner 摘：即便本实例被重建过、token 丢了，也只摘"kunxiansuo-local 装在这个 core 上的"那一份
      removeFence({ owner: 'kunxiansuo-local', core: this.core, token: this._fenceToken });
      this._fenceInstalled = false;
      this._fenceToken = null;
    }
    const toolExec = this.core?.getService?.('tool-executor');
    toolExec?.removeHooksByOwner?.('kunxiansuo-local');
  }
}

export default new KunxiansuoLocal();
