#!/usr/bin/env node
// E3（v0.9.33）：场景**声明 ↔ 真实装配**诊断的独立运行入口。
//
// 用法：
//   node scripts/scene-inspect.mjs coding
//   node scripts/scene-inspect.mjs coding --json        # 机器判读
//   node scripts/scene-inspect.mjs --all                 # 全部随包场景
//
// 退出码（与项目既有约定一致：非零 = 有人该看）：
//   0  一致
//   1  不一致（有 problems：declared_but_missing / unapplied_keys /
//            tool_without_capability / unavailable_plugins）
//   2  用法错误或诊断本身跑不起来（**不等于**"场景没问题"）
//
// 为什么单独一个脚本而不是塞进 `tusunsun` CLI：
//   CLI 目前只有 `--scene` 这种启动参数，没有子命令分发；为了一个只读诊断去发明
//   一套子命令框架，是"为未来可能用到新增框架"的反面教材。而计划书 E3 明确接受
//   "用 CI 输出可检查的装配事实"这一形态。等 CLI 真有子命令机制时再挂进去不迟。
//
// 注意：本脚本**只读**。它不会装载插件、不会改任何配置；它回答的是
// "这个场景文件声称要什么，而当前进程真的装了什么"。
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const imp = (rel) => import(join(ROOT, rel));

function usage(msg) {
  if (msg) console.error(`scene-inspect: ${msg}`);
  console.error('usage: node scripts/scene-inspect.mjs <scene-name> [--json] | --all [--json]');
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const all = argv.includes('--all');
  const name = argv.find((a) => !a.startsWith('--'));
  if (!all && !name) usage('a scene name (or --all) is required');

  const { Core } = await imp('src/core/core.js');
  // 环境变量一律走 `readEnv`，不手写规范名（R0-111/W6）。
  const { readEnv } = await imp('src/core/env.js');
  const core = new Core({ stateDir: readEnv('STATE_DIR') || `${process.env.HOME}/.tusunsun` });
  core.log = () => {};
  core.pluginsDir = join(ROOT, 'plugins');

  const SI = (await imp('plugins/scene-inspect.js')).default;
  const inst = Object.create(SI);
  inst.core = core;

  const names = all
    ? readdirSync(join(ROOT, 'scenes')).filter((f) => f.endsWith('.json5')).map((f) => f.slice(0, -6))
    : [name];

  let bad = 0;
  const reports = [];
  for (const n of names) {
    const r = await inst.inspect(n);
    reports.push(r);
    if (!r.ok) { bad++; continue; }
    if (!r.consistent) bad++;
  }

  if (json) {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  } else {
    for (const r of reports) {
      if (!r.ok) { console.log(`✗ ${r.scene || '?'}  ${r.code}: ${r.error}`); continue; }
      const mark = r.consistent ? '✓' : '✗';
      const counts = r.plugins.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
      const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`${mark} ${r.scene.padEnd(14)} 声明 ${String(r.plugins.length).padStart(2)} · ${summary}`);
      if (r.extra_loaded.length) console.log(`    额外装载（声明里没有）: ${r.extra_loaded.join(', ')}`);
      for (const p of r.problems) {
        console.log(`    问题 ${p.code}: ${JSON.stringify(p.detail).slice(0, 160)}`);
      }
    }
    console.log('');
    console.log(bad === 0 ? '全部一致。' : `${bad} 个场景存在不一致（详见上方"问题"行；用 --json 取完整事实）。`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  // 诊断自己跑不起来时必须以 2 退出：把它当成"没问题"是最危险的失败模式。
  console.error('scene-inspect failed to run:', e?.message || e);
  process.exit(2);
});
