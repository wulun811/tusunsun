// R0-113（专家评审 P1-02）：状态目录的**唯一**解析实现。
//
// 事实（修前）：同一个 CLI 进程里有三套写法 ——
//   · `scripts/cli.mjs` 的 cmdConfig：`args.stateDir || process.env.HOME + '/.tusunsun'`（**不认** TUSUNSUN_STATE_DIR）
//   · `scripts/cli-transport.mjs` / `gatewayIdentity`：`args.stateDir || readEnv('STATE_DIR') || homedir()`
//   · `src/bootstrap/cli.js`（start/status/stop）：`args.stateDir || readEnv('STATE_DIR') || homedir()`
// 于是 `TUSUNSUN_STATE_DIR=~/b tusunsun config get model.model` 读的是 `~/.tusunsun` 的旧值，
// 而 `start` 起在 `~/b` —— "改了配置却不生效"且改动落在**另一个实例**的目录里。
//
// 现在：优先级固定为 `--state-dir > TUSUNSUN_STATE_DIR（含历史别名）> ~/.tusunsun`，
// 所有命令（config / scene / start / status / stop / 插件命令）共用本文件。
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readEnv } from '../src/core/env.js';

/** 解析状态目录（返回绝对路径）。 */
export function resolveStateDir(explicit) {
  const raw = explicit || readEnv('STATE_DIR') || join(homedir(), '.tusunsun');
  return resolve(raw);
}

/** 解析 `<stateDir>/config.json` 的绝对路径。 */
export function resolveConfigPath(explicit) {
  return join(resolveStateDir(explicit), 'config.json');
}

/** 人类可读的状态目录（日志用）：显式给了就照实说，否则标注默认。 */
export function describeStateDir(explicit) {
  return resolveStateDir(explicit);
}
