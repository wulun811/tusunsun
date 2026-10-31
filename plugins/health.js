import { request } from 'node:http';

class HealthPlugin {
  name = 'health';
  version = '0.4.0';
  provides = [{ name: 'health.monitor', type: 'service' }];
  permissions = ['net.outbound'];

  async init(core) {
    this.core = core;
    this._interval = core.get('health.interval') || 30000;
    // R0-103（#4 连带，外部验收提出）：端点**按需解析**（见 _resolveEndpoint），
    // 不再在 init 时定死 9002 —— 自定义端口部署下自检会永远打不通，
    // 于是稳定产出假 health.fail / health.critical。
    this._endpointOverride = core.get('health.endpoint') || null;
    this._failures = 0;
    this._lastOkAt = null;
    this._lastFailAt = null;
    this._maxFailures = core.get('health.maxFailures') || 3;
    this._timer = null;
    // R0-154（v0.9.32 续）：`provides: [{ name:'health.monitor', type:'service' }]` 此前
    // **从来没有对应的 registerService**。于是声明了一个谁也用不到的服务：
    // 实测 `core.getService('health.monitor')` → `undefined`。
    //
    // 为什么这算缺陷：`provides` 会被准入闸门收进 manifest（`_providesOf` 只认 service 类，
    // 正是 `getService()` 的可见面），也会被 `scene show` / 选型读。
    // 声明"我提供健康监控服务"而实际取不到，属于本项目反复修的"声明与执行分叉"，
    // 只是这次断在**服务注册**这一层。
    //
    // 注意方向：这里是**补上注册**（让声明成真），不是删掉声明 ——
    // 健康状态确实是外部该能问的东西（网关 `/health` 用的是另一条路径，
    // 但嵌入式宿主没有网关，只能靠这个服务）。
    core.registerService('health.monitor', this);
  }

  // 解析顺序：显式配置 → 网关**实际绑定**端口（`--port 0` / 自定义端口也能自检）
  // → 配置里的端口 → 历史默认 9002。每次检查都重算：网关可能比 health 晚 listen。
  _resolveEndpoint() {
    if (this._endpointOverride) return this._endpointOverride;
    const bound = this.core.getService('gateway')?.port;
    if (bound) return `http://127.0.0.1:${bound}/health`;
    const cfgPort = this.core.get('gateway.port');
    if (cfgPort) return `http://127.0.0.1:${cfgPort}/health`;
    return 'http://127.0.0.1:9002/health';
  }

  async start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), this._interval);
    this.core.emit('health.started', {
      interval: this._interval,
      endpoint: this._resolveEndpoint(),
      timestamp: new Date().toISOString(),
      sourcePlugin: 'health',
    });
  }

  async stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * R0-154：`health.monitor` 服务对外的**查询面**。
   *
   * 修前这个服务虽然（在这一版之后）能被 `getService` 取到，却没有任何可调用的
   * 查询方法 —— 取到它也只能看到一堆下划线私有字段。声明一个"监控服务"却不给出
   * "现在健康吗"的答案，等于仍然没有服务。
   *
   * 返回的是**进程内已知状态**（最近一次自检的结果与计数），不是重新发起探测：
   * 探测本身由 `_check()` 的定时器做，调用方要的是"此刻的看法"，不该被一次同步探测阻塞。
   * `lastOkAt` 为 null 表示"还没成功过一次" —— 如实表达，不伪装成健康。
   */
  getStatus() {
    return {
      ok: this._failures === 0 && this._lastOkAt != null,
      failures: this._failures,
      maxFailures: this._maxFailures,
      lastOkAt: this._lastOkAt ?? null,
      lastFailAt: this._lastFailAt ?? null,
      intervalMs: this._interval,
      endpoint: this._resolveEndpoint(),
    };
  }

  _check() {
    const t0 = Date.now();
    const endpoint = this._resolveEndpoint();
    const req = request(endpoint, { method: 'GET', timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => {
        this._failures = 0;
        this._lastOkAt = Date.now();
        this.core.emitFast('health.ok', {
          endpoint,
          latency: Date.now() - t0,
          status: res.statusCode,
          timestamp: Date.now(),
          sourcePlugin: 'health',
        });
      });
    });

    req.on('error', () => {
      this._failures++;
      this._lastFailAt = Date.now();
      this.core.emit('health.fail', {
        endpoint,
        failures: this._failures,
        maxFailures: this._maxFailures,
        timestamp: new Date().toISOString(),
        sourcePlugin: 'health',
      });

      if (this._failures >= this._maxFailures) {
        this.core.emit('health.critical', {
          endpoint,
          failures: this._failures,
          timestamp: new Date().toISOString(),
          sourcePlugin: 'health',
        });
      }
    });

    req.end();
  }
}

export default new HealthPlugin();
