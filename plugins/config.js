import { readFile, writeFile, mkdir, chmod, rename, stat } from 'node:fs/promises';
import { readEnv } from '../src/core/env.js';
import { checkConfigPath, assignConfigPath } from './_lib/config-path.mjs';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';

// R0-113（专家评审 P0-01）：默认监听地址从 `0.0.0.0` 收成回环。
// 事实（修前）：默认 0.0.0.0 + 默认 apiKey=null ⇒ 同网段任何机器都能 `POST /api/config`
// 改模型配置（该路由当时无鉴权）、并白用模型额度。要对外必须显式 `allowRemote` + 凭证。
const DEFAULT_CONFIG = {
  activeScene: 'gateway',
  gateway: {
    host: '127.0.0.1',
    port: 9002,
    token: null,
    apiKey: null,
    allowRemote: false,
    corsOrigins: null,
    // R0-114（P1-02）：反向代理/自定义域名部署时，把**可信外部 Host** 显式写在这里。
    // 控制面不再信任"请求自带 Host"，默认只认回环名 + 实际监听端口。
    trustedHosts: null,
  },
  model: {
    provider: 'openai',
    model: 'kimi-k2.5',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    apiKey: null,
    primary: null,
    worker: null,
  },
  agent: {
    systemPrompt: null,
    maxTurns: 10,
    workDir: null,
  },
  // R0-124：会话级工作目录。`agent.workDir` 仍是**默认**基准；这三项决定"会话能不能自己选"。
  //   policy: local（默认，本机调用方可选任意已存在目录）/ rooted（只能选 roots 内的）/
  //           off（关闭，一律用 agent.workDir）
  //   roots : 远端调用方（非回环）在 local 策略下必须落在这些目录里；
  //           rooted 策略下所有人都在这个约束内
  workspaces: {
    policy: 'local',
    roots: null,
  },
  channels: {},
  tools: {
    permissionMode: 'auto',
    safetyReflection: true,
  },
};

// R0-111/W4：`TUSUNSUN_MODEL_HEADERS` 的解析（JSON 对象 → 请求头）。
//
// 为什么必须**报错**而不是"忽略这条环境变量"：header 是网关侧的准入凭据（会话 id / 组织头），
// 值写坏时静默忽略的后果是"服务起得来、每次对话都 400"——报错信息离真正的原因很远。
// 启动即失败，错误里直接点名变量与形状，比任何运行期猜测都省事。
function parseModelHeaders(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TUSUNSUN_MODEL_HEADERS 不是合法 JSON（${err.message}）：${String(raw).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TUSUNSUN_MODEL_HEADERS 必须是 JSON 对象，例如 {"x-opencode-session":"<id>"}');
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!['string', 'number', 'boolean'].includes(typeof v)) {
      throw new Error(`TUSUNSUN_MODEL_HEADERS.${k} 的值必须是字符串/数字/布尔（收到 ${Array.isArray(v) ? 'array' : typeof v}）`);
    }
    if (/[\r\n]/.test(String(v))) {
      throw new Error(`TUSUNSUN_MODEL_HEADERS.${k} 的值不得含换行（HTTP 头注入）`);
    }
  }
  return parsed;
}

// `TUSUNSUN_MODEL_THINKING` 的解析（JSON 对象 → 请求体里的 `thinking`）。
//
// 为什么是对象而不是 `on/off` 字符串：各家的形状不一样（`{"type":"disabled"}`、
// `{"type":"enabled","budget_tokens":N}`），内核没资格替上游定义语义，只做**形状**校验。
// 写坏一律启动即失败：静默忽略的后果是「以为关了思考、模型照样想两千 token」——
// 账上是钱，日志里一点线索都没有。
function parseModelThinking(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`TUSUNSUN_MODEL_THINKING 不是合法 JSON（${err.message}）：${String(raw).slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TUSUNSUN_MODEL_THINKING 必须是 JSON 对象，例如 {"type":"disabled"} 或 {"type":"enabled","budget_tokens":2048}');
  }
  return parsed;
}

class ConfigPlugin {
  name = 'config';
  version = '0.3.0';
  manifest = {
    schema_version: 'tusunsun.plugin/v2',
    name: 'config',
    version: '0.3.0',
    api_version: '1',
    owner: 'platform',
    provides: [{ service: 'config', api_version: '1.0.0' }],
    requires: [],
    surfaces: ['internal'],
    degraded_policy: 'block_startup', // 配置是关键依赖：production 下 init 失败整体拒绝启动
  };
  permissions = ['fs.read', 'fs.write', 'env.read'];

  constructor() {
    this.data = {};
    this.watcher = null;
    // 同一实例的落盘必须排队（见 `_enqueue`）：`save()` 的临时文件名只带 pid。
    this._writeChain = Promise.resolve();
  }

  async init(core) {
    this.core = core;
    await this.ensureStateDir();
    await this.load();
    
    if (!this.data.agent.workDir) {
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');
      this.data.agent.workDir = join(homedir(), '.tusunsun', 'workspace');
      await this.save();
      core.log('info', `Default workDir set to ${this.data.agent.workDir}`);
    }

    // R0-103（开源盘点 #4）：`--port` 是**会话级**最高优先级覆盖（CLI > 环境变量 > 配置文件）。
    // 必须放在上面的 save() 之后：命令行是本次运行的意图，**不得落盘**污染下次启动。
    // 用 `!= null` 而非真值判断——`--port 0`（随机可用端口）是合法意图。
    if (core.port != null) {
      this.data.gateway.port = core.port;
      core.log('info', `Gateway port overridden by CLI: ${core.port}`);
    }

    // R0-105 缺陷 2：把 `agent.workDir` 写进**数据面**。
    // 事实：文件工具用 `core.getData('agent.workDir')` 取工作目录，但全仓只有 PluginManager
    // 往数据面写 `_lazyHook`，**没有任何代码写 `agent.workDir`** ⇒ 配置里的 workDir 被静默
    // 忽略，一切文件操作落到 `process.cwd()`（实测：让它写 out.txt，文件出现在仓库根而不是
    // 配置的工作区）。配置面（`core.get`）有值、数据面（`getData`）没有，两条读取路径不一致
    // ——这正是"半改"的典型形态。
    // 修法选**一处写、所有读者受益**：config 是配置的唯一权威，在这里落一次数据面。
    if (this.data.agent?.workDir) {
      // R0-113（专家评审"五步旅程"）：工作区必须真的存在，否则空 HOME 首次 `tool-write`
      // 直接 ENOENT——"能对话但干不了活"。放在数据面写入之前，保证第一次工具调用就能落盘。
      await this.ensureWorkDir(this.data.agent.workDir);
      core.setData('agent.workDir', this.data.agent.workDir);
    }

    core.registerService('config', this);
  }

  /**
   * R0-114（P1-04）：把既存的 config.json 收到 0600，并在启动日志里说清结果。
   * 只动权限、不动内容（不改写文件 ⇒ 不会因"顺手保存"把 env 覆盖落盘）。
   */
  async _tightenConfigPerms() {
    try {
      const st = await stat(this.core.configPath);
      // 组/其他可读写 = 偏宽。0640/0600/0400 都算合格（只读挂载是合法部署）。
      if ((st.mode & 0o077) === 0) return;
      await chmod(this.core.configPath, 0o600);
      const after = await stat(this.core.configPath);
      if ((after.mode & 0o077) !== 0) {
        this.core.log('warn', `Config ${this.core.configPath} 权限仍为 ${(after.mode & 0o777).toString(8)}（目标 0600）：该文件含明文 key`);
      } else {
        this.core.log('info', `Config 权限已收紧：${(st.mode & 0o777).toString(8)} → 600（${this.core.configPath}）`);
      }
    } catch (err) {
      this.core.log('warn', `无法校准 config.json 权限（${err.code || err.message}）：若该文件含明文 key，请手动 chmod 600`);
    }
  }

  async ensureStateDir() {
    if (!existsSync(this.core.stateDir)) {
      await mkdir(this.core.stateDir, { recursive: true, mode: 0o700 });
    }
    // R0-113（P1-03）：状态目录里有明文 key、会话 JSONL、网关运行期记录 ⇒ 0700。
    // `mkdir` 的 mode 受 umask 影响（实测 umask 022 下建出 0755），故显式 chmod 归一。
    try { await chmod(this.core.stateDir, 0o700); } catch { /* 非 POSIX 文件系统：尽力而为 */ }
  }

  /** 工作区目录（文件工具的相对路径基准）必须先于第一次工具调用存在。 */
  async ensureWorkDir(dir) {
    if (!dir) return;
    await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
    try { await chmod(dir, 0o700); } catch { /* 非 POSIX：尽力而为 */ }
  }

  async load() {
    if (existsSync(this.core.configPath)) {
      try {
        const raw = await readFile(this.core.configPath, 'utf-8');
        this.data = this._deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
        this.core.log('info', `Config loaded from ${this.core.configPath}`);
      } catch (err) {
        this.core.log('warn', `Config parse error: ${err.message}, using defaults`);
        this.data = this._deepMerge(DEFAULT_CONFIG, {});
      }
      // R0-114（P1-04）：**既存**配置的权限要在启动时校准，不能等下一次保存。
      // 事实（修前）：手工产生的 0644 config.json 在启动后仍是 0644 —— 只有“通过授权的
      // Web 配置写入再保存一次”才会被顺带修成 0600。而这个文件里有明文 model/gateway key。
      // 校准失败必须**记日志**（锁定的只读挂载会 chmod 失败），不许静默假装已经安全。
      await this._tightenConfigPerms();
    } else {
      this.data = this._deepMerge(DEFAULT_CONFIG, {});
      await this.save();
      this.core.log('info', `Default config created at ${this.core.configPath}`);
    }
    this.applyEnvOverrides();
  }

  applyEnvOverrides() {
    // R0-111/W6：全部改走 `readEnv()`。手写 `process.env.TUSUNSUN_*` 等于**只认规范名**，
    // 于是只用历史别名的既有部署会静默丢设置——最刺眼的是 key：网关照常起来，每次对话都说
    // "没 key"，看日志的人只会去查配置面，不会想到是前缀问题。
    const model = readEnv('MODEL');
    const baseUrl = readEnv('BASE_URL');
    const port = readEnv('PORT');
    if (readEnv('API_KEY')) this.data.model.apiKey = readEnv('API_KEY');
    if (!this.data.model.apiKey && process.env.LLM_API_KEY) this.data.model.apiKey = process.env.LLM_API_KEY;
    if (model) this.data.model.model = model;
    if (baseUrl) this.data.model.baseUrl = baseUrl;
    if (readEnv('GATEWAY_HOST')) this.data.gateway.host = readEnv('GATEWAY_HOST');
    if (readEnv('GATEWAY_KEY')) this.data.gateway.apiKey = readEnv('GATEWAY_KEY');
    if (port) this.data.gateway.port = parseInt(port, 10);
    if (readEnv('TOKEN')) this.data.gateway.token = readEnv('TOKEN');
    // R0-111/W4：`model.headers` 原先只能写进 config.json ⇒ 纯 env 部署（容器/CI）表达不了。
    // 而有些免费/网关模型强制要会话头（LongCat free 缺 `x-opencode-session` 直接 400
    // `MissingSessionID`，报文与"key 错了"完全不像）。语义与上面几条一致：
    // env 覆盖 config（同名键 env 赢、其余键保留），空串按未设置。
    const headers = readEnv('MODEL_HEADERS');
    if (headers) this.data.model.headers = { ...(this.data.model.headers || {}), ...parseModelHeaders(headers) };
    // 思考开关同理：`{"type":"disabled"}` 这种对象写不进普通变量，但容器/CI 不该被迫改 config.json。
    // 纯 env 部署里这条是"能不能省钱"的开关，必须与 config.json 等价。
    const thinking = readEnv('MODEL_THINKING');
    if (thinking) this.data.model.thinking = parseModelThinking(thinking);
    // R0-112 缺陷 1：工作目录此前只能手改 config.json 里的 `agent.workDir`——容器/CI 这类
    // 纯 env 部署表达不了「agent 在哪个目录干活」。这是**部署事实**（决定文件工具的相对路径
    // 基准落在哪、多个项目会不会共用同一个抽屉），必须能用环境变量钉死。
    const workDir = readEnv('WORK_DIR');
    if (workDir) this.data.agent.workDir = workDir;
    // R0-113（P0-01）：对外监听的显式 opt-in 也能用环境变量表达（容器/CI 场景）。
    if (readEnv('ALLOW_REMOTE') === '1') this.data.gateway.allowRemote = true;
  }

  async save() {
    // R0-113（P1-03）：原子写 + 0600。
    // 事实（修前）：`writeFile(path, …)` 直接覆盖 —— 权限随 umask（实测 0644），而文件里有
    // 明文 `model.apiKey` / `gateway.apiKey`；非原子覆盖还会让并发读者读到半截 JSON
    // （config 插件自己 watch 这个文件，"半截"会被当成损坏而从默认值重建）。
    await mkdir(this.core.stateDir, { recursive: true, mode: 0o700 });
    try { await chmod(this.core.stateDir, 0o700); } catch { /* 非 POSIX：尽力而为 */ }
    const tmp = `${this.core.configPath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { await chmod(tmp, 0o600); } catch { /* 同上 */ }
    await rename(tmp, this.core.configPath);
    try { await chmod(this.core.configPath, 0o600); } catch { /* 老文件也一并收紧 */ }
  }

  // R0-103（#4 连带修复）：必须**深拷贝** base。旧实现 `{ ...base }` 是浅拷贝，于是
  // `this.data.gateway` 与模块级 `DEFAULT_CONFIG.gateway` 是**同一个对象**：
  //   ① 一次 CLI 端口覆盖（`--port`）会污染后续所有实例看到的"默认值"；
  //   ② 任何后续 save()（如切场景的 setAndSave）都会把**会话级覆盖写进配置文件**——
  //      "命令行不落盘"这条承诺就不成立了（门禁 T4 实测抓到）。
  _deepMerge(base, override) {
    const result = {};
    for (const key of Object.keys(base)) {
      const v = base[key];
      result[key] = (v !== null && typeof v === 'object' && !Array.isArray(v)) ? this._deepMerge(v, {}) : v;
    }
    for (const key of Object.keys(override)) {
      const ov = override[key];
      if (ov !== null && typeof ov === 'object' && !Array.isArray(ov)
          && result[key] !== null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this._deepMerge(result[key], ov);
      } else {
        result[key] = ov;
      }
    }
    return result;
  }

  get(path, fallback) {
    const parts = path.split('.');
    let obj = this.data;
    for (const p of parts) {
      if (obj == null) return fallback;
      obj = obj[p];
    }
    return obj ?? fallback;
  }

  set(path, value) {
    // 原型污染：`__proto__` / `constructor` / `prototype` 不能作为写入目标。
    // 判据与 `tusunsun config set` 共用 `_lib/config-path.mjs`（一份实现，两个入口）。
    const checked = checkConfigPath(path);
    if (!checked.ok) {
      // 不静默失败、也不静默改名：这是一个非法请求，具名拒绝比“以为写成功了”诚实。
      throw Object.assign(new Error(`Invalid config path: ${checked.reason}`), {
        code: 'invalid_config_path', contractError: true,
      });
    }
    assignConfigPath(this.data, checked.parts, value);
  }

  /**
   * **一次写入 = 一个事务**：先改内存、再落盘；落盘失败就把这条改动撤回去。
   *
   * 修前是 `this.set(path,value); await this.save();` —— `set` 先改了内存，`save` 失败后
   * 没人恢复它。于是上层（`SecretsManager`）即便回了自己的缓存，`config.get(name)` 仍然返回
   * 那条**没落盘的新值**：同一个失败在两层视图里是两个答案（R23-A）。只回滚上层缓存不够。
   *
   * 回滚是**就地**做的（不换 `this.data` 的对象身份）：别处可能已经拿着这个引用读配置。
   */
  async setAndSave(path, value) {
    return this._enqueue(async () => {
      // 队列**等到之后**才取 target：排队期间 `load()`（watcher 重载）可能把 `this.data`
      // 换成另一个对象，那时 `set` 改的是新对象，拿旧对象的快照回写就是把它整个覆盖掉。
      const target = this.data;
      const backup = this._snapshotData();   // 拿不到快照就不改内存
      this.set(path, value);
      try {
        await this.save();
      } catch (err) {
        if (this.data === target) this._restoreInto(target, backup);   // 换了对象就不回写（会盖掉刚重载的配置）
        throw err;
      }
    });
  }

  /** 同一实例的 `save()` 串行化：临时文件名固定为 `configPath.tmp-<pid>`，并发写会互相踩。 */
  _enqueue(fn) {
    const run = this._writeChain.then(fn, fn);
    this._writeChain = run.then(() => {}, () => {});   // 一次失败不能毒化后续写入
    return run;
  }

  /** `this.data` 的纯数据快照。非纯数据（含循环）走 JSON 往返，与 `save()` 的口径一致。 */
  _snapshotData() {
    try { return structuredClone(this.data); }
    catch { return JSON.parse(JSON.stringify(this.data)); }
  }

  _restoreInto(target, src) {
    for (const k of Object.keys(target)) if (!Object.prototype.hasOwnProperty.call(src, k)) delete target[k];
    for (const k of Object.keys(src)) {
      const b = src[k];
      const cur = target[k];
      if (b !== null && typeof b === 'object' && !Array.isArray(b)
          && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
        this._restoreInto(cur, b);
      } else {
        target[k] = b;
      }
    }
  }

  // W11 批10 跨树对齐（下游→平台）：100ms 防抖重写——编辑器保存会触发多次 change 事件
  // 导致重复 reload；且 load() 抛错曾产生 unhandled rejection
  watchChanges() {
    let reloadTimer = null;
    try {
      this.watcher = watch(this.core.configPath, (eventType) => {
        if (eventType === 'change') {
          clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            this.load().then(() => {
              this.core.emit('config.reloaded', { data: this.data, timestamp: new Date().toISOString(), sourcePlugin: 'config' });
            }).catch(err => {
              this.core.log('warn', `Config reload failed: ${err.message}`);
            });
          }, 100);
        }
      });
    } catch {
      // watch not available
    }
  }

  async start() {
    this.watchChanges();
    this.core.registerCapability('config.get', {
      description: 'Get configuration data, optionally filtered by path',
      handler: async (params) => {
        if (params?.path) return { path: params.path, value: this.get(params.path) };
        return this.data;
      },
      owner: this.name,
    });
  }

  async stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}

// R0-113（P1-01）：默认配置要让 `scripts/cli.mjs` 的首次 `config set` 复用**同一份**默认值
// （否则"CLI 造的文件"与"内核造的文件"两套形状，用户看到的又是另一种不一致）。
export { DEFAULT_CONFIG };
export default new ConfigPlugin();
