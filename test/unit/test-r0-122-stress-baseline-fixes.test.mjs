// R0-122：压测基线建立时暴露出的判据缺陷（先复现、再修、再锁死）
//
//   T1 注释行被当成命令：`# TODO: 校验 rm -rf / 已被拦下` 被硬拦且 retryable:false
//      —— 写注释变成高危操作。
//   T2 `unlink <file>` 两层判据全不命中：`rm -f a.js` 要确认、`unlink a.js` 直接放行，
//      同一个动作两种待遇（而 extractDeleteTargets 早就把 unlink 算进目标抽取了）。
//   T3 关机/重启判据的"外壳前缀"写漏：`timeout 30 reboot`、`env -i PATH=/usr/bin reboot`
//      全部漏判 —— 同一个概念在解释器判据里写了一份、在关机判据里另写了半份。
//   T4 二次回溯：`git checkout ` + 两万个空格 + `--` 让 classifyIrreversible 耗时 498ms
//      （`\s+` 与 `[^|;&]*` 都能吃空白 ⇒ O(n²)）。压测的放大比门禁就是抓这个的。
//
// 本文件锁的是"修好之后不许退化"，因此每条都写**正反两例**：
// 只测"该拦的拦住了"会奖励过度拦截，只测"该放的放过了"会奖励漏判。
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner, assert, assertEquals } from '../harness.mjs';
import {
  matchDangerousCommand, classifyIrreversible, extractDeleteTargets,
} from '../../plugins/_lib/danger-patterns.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const hard = (cmd) => !!matchDangerousCommand(cmd);
const soft = (cmd) => classifyIrreversible(cmd);
const covered = (cmd) => hard(cmd) || !!soft(cmd);

export async function setup(runner) {
  runner.test('R0-122/T1 注释是数据：整行注释、行中注释都不得触发判据', () => {
    const comments = [
      '# TODO: 校验 rm -rf / 已被拦下',
      '# shutdown -h now 已从白名单移除',
      '   # rm -rf /',
      'cd /tmp\n# 清理：rm -rf /*\nls',
      'echo start && # rm -rf / 只是注释',
    ];
    for (const c of comments) {
      assertEquals(hard(c), false, `注释不该硬拦：${JSON.stringify(c)}`);
    }

    // 反例：注释后面真的跟着命令，必须照拦 —— 不能因为"有 #"就整条放过
    assert(covered('cd /tmp\n# 清理\nrm -rf /'), '注释之后的真命令必须仍然命中');
    assert(covered('# 注释\nshutdown -h now'), '注释之后的关机命令必须仍然命中');

    // 已知的保守边界（写在压测语料 EXPECTED_BLOCK 里）：注释剥离先于执行上下文判定，
    // 引号内的 `#` 被当成数据保护起来 ⇒ `bash -c "# …"` 里的注释到不了第二层。
    // 这条**不打算**修：看得出是注释的只有第一层，再往里剥离等于自己开洞。
    assert(hard('bash -c "# rm -rf /"'), '引号内注释仍按代码看待（有意保守）');
  });

  runner.test('R0-122/T2 unlink 与 rm 同等待遇', () => {
    assert(soft('unlink important.txt'), '`unlink <file>` 必须进软闸');
    assert(soft('rm -f important.txt'), '`rm -f <file>` 必须进软闸（对照）');
    assertEquals(soft('unlink --help'), null, '`unlink --help` 是看帮助，不是删文件');
    // 目标抽取早就认 unlink：这条断言防的是"判据与测量口径再次分叉"
    const { targets } = extractDeleteTargets('unlink important.txt');
    assertEquals(JSON.stringify(targets), JSON.stringify(['important.txt']), 'unlink 的目标必须被抽出来');
  });

  runner.test('R0-122/T3 关机/重启的外壳前缀与解释器共用一份', () => {
    const mustBlock = [
      'reboot',
      'sudo shutdown -h now',
      'timeout 30 reboot',
      'env -i PATH=/usr/bin reboot',
      'nice -n 5 poweroff',
      'cd /tmp && reboot',
      'echo x; reboot',
      'bash -c "reboot"',
    ];
    for (const c of mustBlock) assert(hard(c), `必须硬拦：${JSON.stringify(c)}`);

    // 反例：把动词当数据看的日常命令不许误拦（v0.9.13 已修，此处防回归）
    const mustPass = ['grep -n reboot CHANGELOG.md', 'man shutdown', 'git log --grep=halt', 'ps aux | grep poweroff'];
    for (const c of mustPass) assert(!hard(c), `不得硬拦：${JSON.stringify(c)}`);
  });

  runner.test('R0-122/T4 超长空白不得让 git 判据退化成 O(n²)', () => {
    // 修前实测 498ms（两万个空格）；阈值给 50ms，比修复后（<1ms）宽两个数量级，
    // 又能稳稳抓住二次行为 —— 对慢机器也成立。
    const t0 = Number(process.hrtime.bigint());
    classifyIrreversible('git checkout ' + ' '.repeat(20000) + '--');
    classifyIrreversible('git reset ' + ' '.repeat(20000) + '--hard');
    classifyIrreversible('git clean ' + ' '.repeat(20000) + '-fdx');
    const ms = (Number(process.hrtime.bigint()) - t0) / 1e6;
    assert(ms < 50, `三次超长空白判定共 ${ms.toFixed(1)}ms，超过 50ms ⇒ 疑似二次回溯`);

    // 功能本身不许因此丢掉
    assert(soft('git checkout -- src/core'), '`git checkout -- <路径>` 必须命中');
    assert(soft('git reset --hard HEAD~5'), '`git reset --hard` 必须命中');
    assert(soft('git clean -fdx'), '`git clean -fdx` 必须命中');
    assertEquals(soft('git checkout main'), null, '`git checkout main` 是切分支，不是丢弃改动');
  });

  runner.test('R0-122/T5 数据 vs 代码：v0.9.14 的口径未被注释剥离破坏', () => {
    const data = [
      'git commit -m "fix rm -rf handling"',
      'echo "never run rm -rf /"',
      'grep -n "rm -rf" CHANGELOG.md',
      'printf "%s\\n" "mkfs.ext4 /dev/sda1"',
      'cat > notes.md <<\'EOF\'\n危险命令示例：rm -rf /\nEOF',
    ];
    for (const c of data) assert(!hard(c), `文本位置不该硬拦：${JSON.stringify(c)}`);

    const code = [
      'bash -c "rm -rf /"',
      'echo "rm -rf /" | bash',
      'eval "rm -rf /"',
      'ssh prod "rm -rf /var/www"',
      'find . -exec rm -rf {} \\;',
    ];
    for (const c of code) assert(hard(c), `喂给解释器必须拦：${JSON.stringify(c)}`);
  });

  runner.test('R0-122/T6 压测资产不进发布包（否则"不随包发布"这句话就是假的）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assertEquals(pkg.scripts['test:stress'], 'node test/run-stress.mjs', 'test:stress 必须指向压测编排器');

    // `files` 里写目录 = 整目录打进去，`.npmignore` 管不住（npm 文档明写：files 里的路径
    // 不能被 .npmignore/.gitignore 排除）。所以这里断言的是**白名单的形状**：
    // 不许出现裸 `test/`，否则 test/stress/ 会被整目录带进发布包。
    assert(!pkg.files.includes('test/'), 'files 不得写裸 `test/`（会把压测资产整目录带进发布包）');
    for (const must of ['test/*.mjs', 'test/unit/', 'test/integration/']) {
      assert(pkg.files.includes(must), `files 必须显式列出 ${must}`);
    }

    // 光看配置还不够：直接问 npm "你到底会打哪些文件"。
    const npm = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (npm.error || npm.status !== 0) {
      runner.noteSkip('[NOT_RUN] npm 不可用，无法核对真实打包清单');
    } else {
      let paths = [];
      try {
        const info = JSON.parse(npm.stdout);
        paths = (Array.isArray(info) ? info[0]?.files : null)?.map((f) => f.path) || [];
      } catch { /* 下面会因为 paths 为空而失败，比静默跳过好 */ }
      assert(paths.length > 0, 'npm pack --dry-run 没有返回文件清单');
      const leaked = paths.filter((f) => f.startsWith('test/stress/'));
      assertEquals(JSON.stringify(leaked), '[]', `压测资产泄漏进发布包：${leaked.slice(0, 5).join(', ')}`);
    }

    const runnerSrc = readFileSync(join(ROOT, 'test', 'run-stress.mjs'), 'utf8');
    assert(/process\.exit\(1\)/.test(runnerSrc), '压测资产缺失时必须非零退出（R0-113）');
    assert(/bench-\*\.mjs/.test(runnerSrc), '编排器只应认 bench-*.mjs，不能把 lib/ 当用例');
  });
}
