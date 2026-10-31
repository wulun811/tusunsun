// 生产档入口（R0-119）：不起子进程、不依赖 shell，故 Windows 的 cmd.exe/PowerShell 同样可用。
// 此前写作 `"start:production": "TUSUNSUN_PROFILE=production node tusunsun.mjs start"`，
// 那是 POSIX 写法，Windows 上会把整串当成命令名 ⇒ 直接失败。
import { fileURLToPath } from 'node:url';
import { writeEnv } from '../src/core/env.js';

// 前缀只在 src/core/env.js 出现一次：脚本里手写规范名会被 R0-111/W6 判红（也确实该判）。
writeEnv('PROFILE', 'production');
process.argv.splice(1, 1, fileURLToPath(new URL('../tusunsun.mjs', import.meta.url)), 'start');
await import('../tusunsun.mjs');
