#!/usr/bin/env node

// ADR-12（v0.14.1）：正式支持 Node >= 22。18/20 已 EOL，不再支持——
// 与 package.json 的 `engines.node` 必须一致，否则"声明"与"实际拦截"会给出两种答案。
const minNode = 22;
const current = parseInt(process.versions.node);
if (current < minNode) {
  process.stderr.write(`Node.js ${minNode}+ required (current: ${process.versions.node}).\n`
    + '  支持范围见 docs/adr/ADR-12-node-support-matrix.md；Node 18/20 已于 2025/2026 结束维护。\n');
  process.exit(1);
}

// R0-112 缺陷 4：下游提前关掉管道（`tusunsun plugins | head -3`）会让写 stdout 抛 EPIPE。
// POSIX 惯例是**静默**收尾（对比 `ls | head`：不报错、不吐堆栈），此前却被打成
// `Uncaught Exception: Error: write EPIPE` 加一整段堆栈、退出码 1 —— 用户看到的是"命令崩了"。
// 做法：EPIPE 时把该流的后续写入降级为空操作，让命令按自己的语义正常走完（退出码仍由命令决定，
// 不用 exit(0) 硬退，避免顺手掩盖别的错误）；非 EPIPE 的流错误照旧抛出，不静默吞掉。
function _swallowEpPipe(stream) {
  stream.on('error', (err) => {
    if (err?.code !== 'EPIPE') throw err;
    stream.write = () => true;
  });
}
_swallowEpPipe(process.stdout);
_swallowEpPipe(process.stderr);

// R0-111/W10：自动加载**当前工作目录**的 `.env`（只此一处，不向上递归）。
//
// 为什么要有：几乎每个 Node 工具都读 `.env`，用户按习惯把 `TUSUNSUN_API_KEY` 写进去之后，
// 若无人读它，现象是"配了却像没配"——实测 `TUSUNSUN_MODEL=from-dotenv` 写在 `.env` 里，
// `config get model.model` 仍回默认值，且**没有任何提示**。这类静默不生效比报错更难查。
//
// 语义与社区一致（不发明新方言）：已存在的环境变量**优先、绝不覆盖**；只认单行 `KEY=VALUE`，
// `#` 开头为注释，两侧成对引号会被剥掉；**值永不进日志**，只报读了几条（便于"为什么没生效"自查）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadDotenvFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return 0; }   // 没有这个文件是常态，不是错误
  let n = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = val;
    n++;
  }
  return n;
}

const dotenvPath = join(process.cwd(), '.env');
const dotenvCount = loadDotenvFile(dotenvPath);

const args = process.argv.slice(2);

const isBoot = !args.length || args[0] === 'start' ||
  args[0] === '--version' || args[0] === '-v' ||
  (!!args[0] && args[0].startsWith('--') && args[0] !== '--help' && args[0] !== '-h');

if (isBoot) {
  const { main } = await import('./src/bootstrap/cli.js');
  main();
} else {
  await import('./scripts/cli.mjs');
}
