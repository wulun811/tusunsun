// ReDoS 探针：在**子进程**里跑对抗输入矩阵。
//
// 为什么必须单独一个进程：灾难性回溯一旦触发，事件循环就再也回不来了 —— 父进程里
// `await withDeadline(...)` 那个 setTimeout 永远等不到执行机会。只有把这堆正则扔进
// 另一个进程，父进程才能用墙钟（wall clock）判"它挂了"。
//
// 两把尺子，缺一不可：
//   ① **放大比**（主业）：同一形态在 5k 和 60k 下各测一次。线性 ⇒ 比值 ≈ 12；
//      二次 ⇒ ≈ 144。比值与机器快慢**无关**，所以它是真正的门禁。
//      只测绝对值是错的：慢机器上的线性也慢，会被误判成退化。
//   ② **绝对上限**（副业）：单次 60k 字符输入不许超过 50ms。它不判"好坏"，只判
//      "是不是已经挂在半路上了"，给一个硬天花板。
//
// 输出：一行 JSON
import { matchDangerousCommand, classifyIrreversible, extractDeleteTargets } from '../../../plugins/_lib/danger-patterns.js';

const now = () => Number(process.hrtime.bigint());
const run = (s) => { matchDangerousCommand(s); classifyIrreversible(s); extractDeleteTargets(s); };
const timeIt = (s) => {
  let best = Infinity;
  for (let r = 0; r < 3; r++) { const t0 = now(); run(s); best = Math.min(best, (now() - t0) / 1e6); }
  return best;
};

// ── ① 固定对抗输入（绝对上限用）────────────────────────────────
const N = 20000;
const fill = (s) => s.repeat(N);

const INPUTS = [
  { label: 'rm + 重复长选项', s: 'rm ' + fill('--a ') },
  { label: 'rm + 重复双横线', s: 'rm ' + fill('--') },
  { label: 'rm + 重复短选项', s: 'rm ' + fill('-a ') },
  { label: 'truncate + 重复 -s', s: 'truncate ' + fill('-s ') },
  { label: 'git checkout + 空白 + --', s: 'git checkout ' + ' '.repeat(N) + '--' },
  { label: '空白 + 重定向', s: ' '.repeat(N) + '>' },
  { label: '嵌套 $(', s: fill('$(') },
  { label: '未闭合反引号', s: '`' + fill('a') },
  { label: '未闭合双引号', s: '"' + fill('a') },
  { label: '未闭合单引号', s: "'" + fill('a') },
  { label: '未闭合 heredoc', s: '<<EOF\n' + fill('a') },
  { label: '超长注释', s: '#' + fill('a') },
  { label: '注释后接真命令', s: '#' + fill('a') + '\nrm -rf /' },
  { label: '超长无结构串', s: fill('x') },
  { label: 'find + 重复 -name + -exec', s: 'find ' + fill('-name x ') + '-exec' },
  { label: 'env + 重复赋值 + reboot', s: 'env ' + fill('A=1 ') + 'reboot' },
  { label: 'rm -rf + 深路径', s: 'rm -rf ' + fill('a/') },
  { label: '重复重定向', s: fill('a >') },
  { label: 'cat + 重复目标', s: 'cat ' + fill('/etc/passwd ') },
  { label: 'rm -rf + 重复参数', s: 'rm -rf ' + 'a '.repeat(N) + '-rf' },
];

let maxMs = 0;
let slowest = null;
let totalMs = 0;
for (const { label, s } of INPUTS) {
  const ms = timeIt(s);
  totalMs += ms;
  if (ms > maxMs) { maxMs = ms; slowest = { label, ms }; }
}

// ── ② 规模放大（真正抓二次/指数行为）──────────────────────────
const SCALES = [
  { label: 'rm + 重复长选项', build: (n) => 'rm ' + '--a '.repeat(n) },
  { label: 'rm + 重复短选项', build: (n) => 'rm ' + '-a '.repeat(n) },
  { label: 'truncate + 重复 -s', build: (n) => 'truncate ' + '-s '.repeat(n) },
  { label: 'env + 重复赋值', build: (n) => 'env ' + 'A=1 '.repeat(n) },
  { label: 'cat + 重复目标', build: (n) => 'cat ' + '/etc/passwd '.repeat(n) },
  { label: '重复重定向', build: (n) => 'a >'.repeat(n) },
  { label: 'find + 重复 -name', build: (n) => 'find ' + '-name x '.repeat(n) + '-exec' },
  { label: 'git + 超长空白', build: (n) => 'git checkout ' + ' '.repeat(n * 4) + '--' },
  { label: '嵌套 $(', build: (n) => '$('.repeat(n) },
  { label: '未闭合引号', build: (n) => '"' + 'a'.repeat(n * 4) },
];

let worstRatio = 0;
let worstScale = null;
for (const { label, build } of SCALES) {
  const tSmall = timeIt(build(5000));
  const tLarge = timeIt(build(60000));
  // 小样本可能测到 0：加一个极小分母兜底，避免除零放大噪声
  const ratio = tLarge / Math.max(tSmall, 0.01);
  if (ratio > worstRatio) { worstRatio = ratio; worstScale = { label, ratio, tSmall, tLarge }; }
}

process.stdout.write(JSON.stringify({
  cases: INPUTS.length,
  scaleCases: SCALES.length,
  totalMs: Number(totalMs.toFixed(3)),
  maxMs: Number(maxMs.toFixed(3)),
  slowest: slowest ? { label: slowest.label, ms: Number(slowest.ms.toFixed(3)) } : null,
  worstRatio: Number(worstRatio.toFixed(2)),
  worstScale: worstScale ? {
    label: worstScale.label,
    ratio: Number(worstScale.ratio.toFixed(2)),
    smallMs: Number(worstScale.tSmall.toFixed(3)),
    largeMs: Number(worstScale.tLarge.toFixed(3)),
  } : null,
}));
