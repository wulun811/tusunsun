// **门禁自检夹具**：一个故意「假绿」的套件。
//
// 它做的事只有两件：打印一份内部 `Failed: 3` 的汇总，然后 `process.exit(0)`。
// 这正是 G1（以及它的空壳形变）描述的形状：进程说成功，内容说失败。
//
// 发布门禁在**每次运行**时都会跑它，并要求判定结果是 `FAIL`。
// 若哪天门禁把 `Failed: 3 + rc=0` 判成 PASS，门禁自己会红。
// 这个文件不得被「修正」成打印 Failed: 0 —— 它是检验器，不是被测对象。
console.log('  [PASS] canary/fake-1');
console.log('  [FAIL] canary/fake-2');
console.log('  [FAIL] canary/fake-3');
console.log('  [FAIL] canary/fake-4');
console.log('');
console.log('=== Summary ===');
console.log('  Total: 4 | Passed: 1 | Failed: 3 | Skipped: 0');
process.exit(0);
