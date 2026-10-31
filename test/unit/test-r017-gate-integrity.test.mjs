// R0-017（rc.15）：**门禁完整性** —— 门禁自己必须能被证伪。
//
// 背景（专家 rc.14 裁决 P0-0 / G1）：
//   旧 `release-gate.mjs` 的判据只有 `rc !== 0 ? FAIL : PASS`。
//   `countFromOutput(out, 'Failed')` 算出来了，但**从未参与判定**。
//   后果：一个内部打印 `Failed: 3` 却 `process.exit(0)` 的套件，或者一个只写了
//   `process.exit(0)` 的空壳文件，都会被记成 PASS。
//   当四类这样的口子同时存在时，「全绿」这句话就没有任何证据力。
//
// 本用例测两层：
//   ① 规则层：`verdictFor` 对每种形状给出正确状态词（不跑子进程，瞬时）；
//   ② 接线层：真的起一个子进程跑那个会伪造失败打印的夹具，把它的**真实输出**
//      喂给规则。规则对、接线错，一样是假绿；只测其中一层不够。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { countFromOutput, verdictFor } from '../../scripts/gate-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CANARY = join(ROOT, 'test', 'fixtures', 'gate-canary', 'false-green.mjs');

/** 跑一次夹具，返回它的真实观测。 */
function observe(args) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    exitCode: r.status == null ? `signal:${r.signal}` : r.status,
    failed: countFromOutput(out, 'Failed'),
    skipped: countFromOutput(out, 'Skipped'),
    total: countFromOutput(out, 'Total'),
    out,
  };
}

export async function setup(runner) {
  // ── ① 规则层 ────────────────────────────────────────────────────────
  runner.test('R0-017/1 G1 原点：rc=0 但内部 Failed: 3 必须判 FAIL', async () => {
    const v = verdictFor({ exitCode: 0, failed: 3, skipped: 0, total: 4, evidence: 'suite' });
    assertEquals(v.status, 'FAIL', '这正是 G1：进程说成功、内容说失败');
    assert(/Failed: 3/.test(v.reason), `理由应点名 Failed: 3，实际：${v.reason}`);
  });

  runner.test('R0-017/2 空壳 exit 0（无任何计数）必须判 FAIL，不能记 PASS', async () => {
    const v = verdictFor({ exitCode: 0, failed: null, skipped: null, total: null, evidence: 'suite' });
    assertEquals(v.status, 'FAIL', '没有 Total 就无法区分「跑了 1143 个」与「什么都没跑」');
    assert(/Total/.test(v.reason), `理由应点名缺少 Total，实际：${v.reason}`);
  });

  runner.test('R0-017/3 0 用例必须判 FAIL', async () => {
    assertEquals(verdictFor({ exitCode: 0, total: 0, evidence: 'suite' }).status, 'FAIL');
  });

  runner.test('R0-017/4 真实全绿仍然 PASS（不得把真绿也判红）', async () => {
    const v = verdictFor({ exitCode: 0, failed: 0, skipped: 0, total: 1143, evidence: 'suite' });
    assertEquals(v.status, 'PASS', '过度收紧与不收紧一样是错的');
  });

  runner.test('R0-017/5 有跳过就是 SKIP，不是 PASS', async () => {
    assertEquals(verdictFor({ exitCode: 0, failed: 0, skipped: 2, total: 10, evidence: 'suite' }).status, 'SKIP');
  });

  runner.test('R0-017/6 非 0 退出码失败；signal:* 也算失败', async () => {
    assertEquals(verdictFor({ exitCode: 1, failed: 0, total: 10, evidence: 'suite' }).status, 'FAIL');
    assertEquals(verdictFor({ exitCode: 'signal:SIGKILL', total: 10, evidence: 'suite' }).status, 'FAIL');
  });

  runner.test('R0-017/7 tool 类不以 Total 为合同（行数/指纹检查没有用例计数）', async () => {
    const v = verdictFor({ exitCode: 0, failed: null, skipped: null, total: null, evidence: 'tool' });
    assertEquals(v.status, 'PASS', '对没有标准汇总的工具，退出码就是合同；但不得用它冒充 suite 已跑过');
  });

  runner.test('R0-017/8 countFromOutput 缺失时返回 null，不回退成 0', async () => {
    assertEquals(countFromOutput('nothing here', 'Total'), null,
      '回退成 0 会让「没打印」与「打印了 0」无法区分');
    assertEquals(countFromOutput('Total: 0', 'Total'), 0, '0 是合法值，不能被当成缺失');
    assertEquals(countFromOutput('Total: 5\nTotal: 7', 'Total'), 7, '取最后一条：汇总行在末尾');
  });

  runner.test('R0-017/8b 探针退出码 3 = NOT_RUN，不是 PASS 也不是 FAIL', async () => {
    const v = verdictFor({ exitCode: 3, evidence: 'probe' });
    assertEquals(v.status, 'NOT_RUN', '前置缺失既不能算通过，也不该算产品失败');
    assert(/前置/.test(v.reason), `理由应点名前置缺失：${v.reason}`);
    // 同样的退出码在 suite 上仍是失败：约定只属于探针，不得泛化。
    assertEquals(verdictFor({ exitCode: 3, evidence: 'suite' }).status, 'FAIL');
  });

  // ── ② 接线层：真起子进程 ─────────────────────────────────────────────
  runner.test('R0-017/9 夹具确实是「假绿」：rc=0 且内部 Failed: 3', async () => {
    const o = observe([CANARY]);
    assertEquals(o.exitCode, 0, `夹具自身必须 exit 0，实际 ${o.exitCode}`);
    assertEquals(o.failed, 3, `夹具必须打印 Failed: 3，实际 ${o.failed}`);
    assertEquals(o.total, 4, `夹具必须打印 Total: 4，实际 ${o.total}`);
    console.log(`       [实测] rc=${o.exitCode} / Total=${o.total} / Failed=${o.failed}`);
  });

  runner.test('R0-017/10 真实输出经规则后必须判 FAIL', async () => {
    const o = observe([CANARY]);
    const v = verdictFor(o);
    assertEquals(v.status, 'FAIL', `伪造的失败打印必须被判红，实际 ${v.status}`);
  });

  runner.test('R0-017/12 计数只认**独立标签**：表单字段名不得被当成失败计数', async () => {
    // 真事：2026-10-26 的 rc.15 发布门禁报出 3 个 FAIL，其中 r25 探针其实 9 条全 FIXED，
    // 它输出里有一行 `requiredFailed:1` —— `Failed:\s*(\d+)` 在这个子串上匹配成了
    // 「Failed: 1」。假红不是“安全”：它会逼人去改夹具或放宽判据，而那正是判据退化的入口。
    const cases = [
      ['requiredFailed:1', null],
      ['criticalFailed:1', null],
      ['x.requiredFailed: 0', null],
      ['  Failed: 3', 3],
      ['Failed:0', 0],
      ['x Failed: 2', 2],
    ];
    for (const [text, want] of cases) {
      assertEquals(countFromOutput(text, 'Failed'), want,
        `countFromOutput(${JSON.stringify(text)}) 应为 ${want}`);
    }
    // 反向：真失败打印必须仍被认出来，修边界不得把真红也吃掉。
    const v = verdictFor({
      exitCode: 0, failed: countFromOutput('Total: 10 | Failed: 2', 'Failed'),
      total: countFromOutput('Total: 10 | Failed: 2', 'Total'), evidence: 'suite',
    });
    assertEquals(v.status, 'FAIL', '修边界之后真失败打印仍必须判红');
  });

  runner.test('R0-017/11 门禁每次运行都做自检，且自检失败会让门禁变红', async () => {
    const src = readFileSync(join(ROOT, 'scripts', 'release-gate.mjs'), 'utf8');
    assert(/gate-canary\/false-green\.mjs/.test(src), '门禁必须引用自检夹具');
    assert(/canary/, '门禁必须记录自检结果');
    assert(/gate-canary-selfcheck/.test(src),
      '自检不通过时必须推入一个 FAIL 项，否则「门禁失去识别假绿的能力」这件事本身不会被发现');
    assert(src.includes("from './gate-verdict.mjs'"), '门禁必须从 gate-verdict.mjs 取判定规则（单一真相）');
  });
}
