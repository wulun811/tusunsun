import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';

const STATE = {
  pending: new Map(),
  seq: 0,
};

function reply(id, result) {
  process.send({ id, ...result });
}

function replyOk(id, data) {
  reply(id, { ok: true, data });
}

function replyErr(id, error) {
  reply(id, { ok: false, error });
}

/**
 * eval 的 context 只接收 JSON 数据：函数、原型与循环引用都可能把宿主对象带进沙箱。
 * 建在 null 原型对象上，`__proto__` 键不会被当成原型赋值。
 */
function jsonContext(raw) {
  if (raw == null) return Object.create(null);
  const parsed = JSON.parse(JSON.stringify(raw));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
  const out = Object.create(null);
  for (const key of Object.keys(parsed)) {
    Object.defineProperty(out, key, { value: parsed[key], writable: true, enumerable: true, configurable: true });
  }
  return out;
}

// eval 可能返回会异步拒绝的 Promise（无效 wasm 字节等）。判据已挡住代码生成，
// 这里兜住异步拒绝：一个沙箱请求不该把子进程打挂。
process.on('unhandledRejection', (err) => {
  try { process.stderr.write(`[sandbox] unhandled rejection: ${err?.message || err}\n`); } catch { /* stderr 已关闭 */ }
});

process.on('message', (msg) => {
  const { id, op, args } = msg;

  try {
    switch (op) {
      case 'bash': {
        const cmd = (args.command || '').trim();
        if (!cmd) { replyErr(id, 'Empty command'); break; }
        replyOk(id, execSync(cmd, {
          encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024,
        }));
        break;
      }

      case 'read':
        replyOk(id, readFileSync(args.path, 'utf8'));
        break;

      case 'write':
        writeFileSync(args.path, args.content, 'utf8');
        replyOk(id, `Written ${args.content.length} bytes`);
        break;

      case 'list':
        replyOk(id, readdirSync(args.path).join('\n'));
        break;

      case 'stat':
        replyOk(id, JSON.stringify(statSync(args.path)));
        break;

      case 'eval': {
        const code = String(args?.code ?? '');
        if (!code.trim()) { replyErr(id, 'Empty code'); break; }
        // 本 context 没有模块 loader：`import()` 会以未处理拒绝杀掉子进程，因此在入口拒绝。
        // 它不是逃逸面 —— 真正堵住 process 的是下面的 context 配置。
        if (/\bimport\b/.test(code)) {
          replyErr(id, 'eval blocked: dynamic import is not available in the sandbox context');
          break;
        }
        const sandbox = jsonContext(args?.context);
        // 不注入宿主 Math/JSON：它们的 constructor 链能拿到宿主 Function。context 自带
        // intrinsics；禁止从字符串生成代码后，Math.constructor.constructor(...) 只会抛 EvalError。
        sandbox.WebAssembly = undefined;
        const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
        // String() 也放进受超时保护的脚本里：返回对象若带自定义 toString，宿主侧调用会绕开 timeout。
        const result = vm.runInContext(`String((${code}))`, context, { timeout: 3000 });
        replyOk(id, result);
        break;
      }

      case 'ping':
        replyOk(id, 'pong');
        break;

      default:
        replyErr(id, `Unknown op: ${op}`);
    }
  } catch (err) {
    replyErr(id, err.message);
  }
});

process.send({ ready: true, pid: process.pid });
