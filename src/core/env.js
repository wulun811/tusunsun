// 环境变量解析：本平台的规范名前缀是 `TUSUNSUN_`。
//
// 旧前缀 `TONGTIAN_` 仍被读取，但只作兼容别名。不能直接停读：生产档准入是 fail-closed 的
// （profile=production 才启用准入闸门），既有部署的 `<前缀>_PROFILE=production` 一旦失效，
// 闸门会被静默关掉 —— 那是安全事故，不是兼容性问题。
//   ① 两个前缀同时存在 ⇒ 规范名赢（旧变量不得覆盖新配置）；
//   ② 只有别名 ⇒ 仍然生效，但新代码、文案、文档一律只写规范名。
// 空串按"未设置"处理，与 `process.env.X || 默认值` 的既有语义一致。

const PREFIX = 'TUSUNSUN_';
const LEGACY_PREFIX = 'TONGTIAN_';

// 规范名优先，旧前缀兜底；undefined 表示两者皆未设置。
function readEnv(name) {
  return process.env[PREFIX + name] || process.env[LEGACY_PREFIX + name];
}

// 写入只点名规范名：别名可以读，不能写。
function writeEnv(name, value) {
  process.env[PREFIX + name] = String(value);
}

// 日志分流：人读日志恒走 stderr，JSONL 只在机器模式下发 stdout —— 同一事件绝不写两条流，
// 否则终端里每行重复，而机器流里混进横幅。
//   LOG_FORMAT=json  → 恒发（显式要求）；human/off → 恒不发（只要人读）
//   未设置/auto      → stdout 非 TTY（重定向、管道、CI）时发，终端里不发
function jsonLogEnabled(stream = process.stdout) {
  const fmt = String(readEnv('LOG_FORMAT') || 'auto').toLowerCase();
  if (fmt === 'json') return true;
  if (fmt === 'human' || fmt === 'off') return false;
  return !stream.isTTY;
}

export { readEnv, writeEnv, jsonLogEnabled };
