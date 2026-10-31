// tests/lite-cases.mjs — LIUHE-L01～L23 反例矩阵
//
// 每条用例都落到真实磁盘效果：写后读文件、预览前后快照对比、冲突后核对旧内容未被覆盖。
// 断言失败不抛异常（收集到 failures），由 runner 汇总成 PASS/FAIL/SKIP/NOT_RUN 报表。
//
// L17–L23（0.1.1）：事务所有权、跨版本/跨发行者、撤销后新改动、脱敏、错误合同完整性、多进程竞争。
// L24–L26（0.1.2 自查）：undo 的 request_id 幂等/归属、ok:false 必须带 error、过期口径 + 日记路径作用域 + 读取有界。
// L27–L28（0.1.3，土行孙 A-1/A-2）：过期日记自动清扫（只清自己的）；过期口径在 inspect/undo/reconcile 三处一致。

import { spawnSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  sha256, makeWorkspace, writeFile, readFile, fileExists, snapshot, diffSnapshots,
  makeEditor, findLatestTxn, countJournals, symlink, isSymlink, rmrf, wasKilled,
} from './harness.mjs'
import { createCellAdapter } from '../examples/cell-adapter.mjs'
import { LiteErrorCodes, RETRY_POLICY, RETRY_VALUES } from '../lite/errors.js'
import { redactPaths } from '../lite/receipt.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

// 直接改事务日记（伪造 / 改格式用）——journal 目录是 Lite 自己的，不存在就抛
function patchJournal(ws, txnId, { state = {}, manifest = {} } = {}) {
  const dir = join(ws, '.malong', 'journal', txnId)
  const s = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...s, ...state }, null, 2))
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...m, ...manifest }, null, 2))
}

function journalSnapshot(ws, txnId) {
  const dir = join(ws, '.malong', 'journal', txnId)
  return {
    state: readFileSync(join(dir, 'state.json'), 'utf-8'),
    manifest: readFileSync(join(dir, 'manifest.json'), 'utf-8'),
  }
}

function collector() {
  const failures = []
  const notes = []
  return {
    failures,
    notes,
    check(cond, msg) {
      if (!cond) failures.push(msg)
      return !!cond
    },
    note(msg) { notes.push(msg) },
  }
}

export const CASES = [
  // ── L01 单文件正常写入 ──
  {
    id: 'L01', title: '单文件正常写入', criterion: '回执 before/after hash 与真实文件核对一致',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l01')
      writeFile(ws, 'notes.txt', 'hello v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'notes.txt' })
      t.check(a.ok, 'readAnchor 失败: ' + JSON.stringify(a.error))
      const r = await ed.apply({ anchor: a.anchor, newContent: 'hello v2\n', requestId: 'req-l01' })
      t.check(r.ok === true, 'apply 未成功: ' + JSON.stringify(r.error))
      const disk = readFile(ws, 'notes.txt')
      t.check(disk === 'hello v2\n', '磁盘内容不是新内容: ' + JSON.stringify(disk))
      t.check(r.receipt?.effect?.after_sha256 === sha256(disk), '回执 after_sha256 与真实文件 hash 不一致')
      t.check(r.receipt?.effect?.before_sha256 === a.anchor.sha256, '回执 before_sha256 与锚点不一致')
      t.check(r.receipt?.effect?.target === 'notes.txt', '回执 target 不是工作区相对路径')
      t.check(r.receipt?.verification === 'not_run', 'verification 不得因写入成功而标为已验证')
      t.check(r.receipt?.recovery?.supported === true, '已提交动作应带 Undo 承诺')
      t.check(r.receipt?.persistence === 'persisted', 'persistence 应为 persisted')
    },
  },

  // ── L02 新文件创建 ──
  {
    id: 'L02', title: '新文件创建', criterion: '明确 created 与不存在前态，不伪造旧 hash',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l02')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'new/dir/file.txt' })
      t.check(a.ok && a.anchor.exists === false, '锚点应报告文件不存在')
      t.check(a.anchor.sha256 === null, '不存在的前态不得编造 hash')
      const r = await ed.apply({ anchor: a.anchor, newContent: 'created\n', requestId: 'req-l02' })
      t.check(r.ok === true, 'apply 未成功: ' + JSON.stringify(r.error))
      t.check(r.receipt?.effect?.kind === 'file_created', 'effect.kind 应为 file_created')
      t.check(r.receipt?.effect?.before_sha256 === null, '新建动作不得有 before hash')
      t.check(fileExists(ws, 'new/dir/file.txt'), '文件未落盘')
      t.check(readFile(ws, 'new/dir/file.txt') === 'created\n', '落盘内容不正确')
    },
  },

  // ── L03 预览无副作用 ──
  {
    id: 'L03', title: '预览无副作用', criterion: 'preview 后磁盘字节完全不变',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l03')
      writeFile(ws, 'a.txt', 'one\ntwo\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const before = snapshot(ws)
      const p = ed.preview({ anchor: a.anchor, newContent: 'one\nTWO\n' })
      const after = snapshot(ws)
      t.check(p.ok === true, 'preview 失败: ' + JSON.stringify(p.error))
      t.check(p.preview?.applied === false, 'preview 必须明确 applied=false')
      t.check(p.preview?.expected_before_sha256 === a.anchor.sha256, 'expected_before_sha256 不等于锚点')
      t.check(p.preview?.expected_after_sha256 === sha256('one\nTWO\n'), 'expected_after_sha256 不等于新内容 hash')
      const changed = diffSnapshots(before, after)
      t.check(changed.length === 0, 'preview 改变了磁盘状态: ' + JSON.stringify(changed))
      t.check(countJournals(ws) === 0, 'preview 不该创建事务日记')
    },
  },

  // ── L04 写前文件被他人更改 ──
  {
    id: 'L04', title: '写前文件被他人更改', criterion: 'VERSION_CONFLICT，旧文件内容不被覆盖',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l04')
      writeFile(ws, 'a.txt', 'mine\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      writeFile(ws, 'a.txt', 'someone-else\n')       // 外部改写（绕开 Lite）
      const r = await ed.apply({ anchor: a.anchor, newContent: 'mine v2\n', requestId: 'req-l04' })
      t.check(r.ok === false, '冲突时必须拒绝')
      t.check(r.error?.code === 'VERSION_CONFLICT', '错误码应为 VERSION_CONFLICT，实得 ' + r.error?.code)
      t.check(readFile(ws, 'a.txt') === 'someone-else\n', '冲突时不得覆盖他人改动')
    },
  },

  // ── L05 再调用相同 requestId ──
  {
    id: 'L05', title: '再调用相同 requestId', criterion: '幂等或具名拒绝，不重复写入',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l05')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r1 = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l05' })
      t.check(r1.ok === true, '首次 apply 失败')
      const r2 = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l05' })
      t.check(r2.ok === true, '同 request_id 重放应幂等成功')
      t.check(r2.detail?.idempotent_replay === true, '重放未标记为幂等复读')
      t.check(r2.receipt?.action_id === r1.receipt?.action_id, '重放返回了不同的 action_id')
      t.check(countJournals(ws) === 1, '重放产生了额外事务日记（重复写入）')
      t.check(readFile(ws, 'a.txt') === 'v2\n', '磁盘内容异常')
      // 同 id 异载荷 → 具名拒绝
      const r3 = await ed.apply({ anchor: a.anchor, newContent: 'v3\n', requestId: 'req-l05' })
      t.check(r3.ok === false && r3.error?.code === 'REQUEST_CONFLICT', '同 id 异载荷应具名拒绝')
      t.check(readFile(ws, 'a.txt') === 'v2\n', '被拒的异载荷请求不得写盘')
    },
  },

  // ── L06 同一文件的并发 apply ──
  {
    id: 'L06', title: '同一文件的并发 apply', criterion: '唯一确定性提交或冲突拒绝，不能静默丢失数据',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l06')
      writeFile(ws, 'a.txt', 'base\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const [r1, r2] = await Promise.all([
        ed.apply({ anchor: a.anchor, newContent: 'writer-1\n', requestId: 'req-l06-a' }),
        ed.apply({ anchor: a.anchor, newContent: 'writer-2\n', requestId: 'req-l06-b' }),
      ])
      const oks = [r1, r2].filter((r) => r.ok === true)
      const conflicts = [r1, r2].filter((r) => r.ok === false && r.error?.code === 'VERSION_CONFLICT')
      t.check(oks.length === 1, '应有且仅有一个成功提交，实得 ' + oks.length)
      t.check(conflicts.length === 1, '另一个应是 VERSION_CONFLICT，实得 ' + conflicts.length)
      const disk = readFile(ws, 'a.txt')
      t.check(disk === 'writer-1\n' || disk === 'writer-2\n', '落盘内容不是任一方的完整内容（疑似混合/丢失）')
      t.check(countJournals(ws) === 1, '并发下应只有一份事务日记')
    },
  },

  // ── L07 成功 Undo ──
  {
    id: 'L07', title: '成功 Undo', criterion: '回到目标旧版本且返回可核对的新回执',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l07')
      writeFile(ws, 'a.txt', 'original\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'changed\n', requestId: 'req-l07' })
      t.check(r.ok === true, 'apply 失败')
      const u = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l07-undo' })
      t.check(u.ok === true, 'undo 失败: ' + JSON.stringify(u.error))
      t.check(readFile(ws, 'a.txt') === 'original\n', 'undo 后文件未回到旧版本')
      t.check(u.receipt?.effect?.after_sha256 === sha256('original\n'), 'undo 回执 after hash 与真实文件不一致')
      t.check(u.receipt?.effect?.kind === 'file_restored', 'undo effect.kind 应为 file_restored')
      // 撤销后的对账口径：净效果为无，但必须标明是「提交过又撤销」，不是「从没落地」
      const rec = ed.reconcile({ actionId: r.receipt.action_id })
      t.check(rec.receipt?.application === 'not_applied', '撤销后净效果应为 not_applied，实得 ' + rec.receipt?.application)
      t.check(rec.receipt?.extension?.journal_state === 'undone', '撤销后 journal_state 应为 undone')
      t.check(/undone/.test(rec.receipt?.extension?.reason || ''), '撤销后的 reason 必须写明是「撤销」而非「从未落地」')
    },
  },

  // ── L08 Undo 前被人再次修改 ──
  {
    id: 'L08', title: 'Undo 前被人再次修改', criterion: 'UNDO_CONFLICT，后续更改保留',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l08')
      writeFile(ws, 'a.txt', 'original\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'changed\n', requestId: 'req-l08' })
      writeFile(ws, 'a.txt', 'later-edit\n')           // 动作之后又被人改了
      const u = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l08-undo' })
      t.check(u.ok === false, 'undo 必须拒绝')
      t.check(u.error?.code === 'UNDO_CONFLICT', '错误码应为 UNDO_CONFLICT，实得 ' + u.error?.code)
      t.check(readFile(ws, 'a.txt') === 'later-edit\n', '后续改动被覆盖了')
    },
  },

  // ── L09 工作区外 / ../ / 同名前缀目录 ──
  {
    id: 'L09', title: '工作区外、../、同名前缀目录', criterion: '拒绝，工作区外无落盘',
    async run(t) {
      const root = t.root
      const ws = makeWorkspace(root, 'l09ws')
      const sibling = makeWorkspace(root, 'l09ws-sibling')
      writeFile(sibling, 'secret.txt', 'secret\n')
      const ed = makeEditor(ws)
      const targets = ['../l09ws-sibling/secret.txt', '../escape.txt', '/etc/hosts', 'sub/../../out.txt']
      for (const p of targets) {
        const a = ed.readAnchor({ path: p })
        t.check(a.ok === false, '越界路径应被拒: ' + p)
        t.check(a.error?.code === 'PATH_OUT_OF_SCOPE', '越界错误码错: ' + p + ' → ' + a.error?.code)
        const r = await ed.apply({ anchor: { path: p, exists: false, sha256: null }, newContent: 'x\n', requestId: 'req-l09-' + p })
        t.check(r.ok === false && r.error?.code === 'PATH_OUT_OF_SCOPE', '越界 apply 应被拒: ' + p)
      }
      t.check(readFile(sibling, 'secret.txt') === 'secret\n', '工作区外文件被改动了')
      t.check(!fileExists(root, 'escape.txt'), '工作区外产生了落盘')
    },
  },

  // ── L10 符号链接 / 父目录符号链接 ──
  {
    id: 'L10', title: '符号链接/父目录符号链接', criterion: '要么安全拒绝，要么给出明确非安全支持边界',
    skipIf: (platform) => (platform === 'win32' ? 'Windows 创建符号链接需开发者模式/管理员特权，CI 上不可用' : null),
    async run(t) {
      const root = t.root
      const ws = makeWorkspace(root, 'l10ws')
      const other = makeWorkspace(root, 'l10other')
      writeFile(other, 'secret.txt', 'secret\n')
      writeFile(ws, 'inside.txt', 'inside\n')
      symlink(join(other, 'secret.txt'), join(ws, 'link-out'))
      symlink(join(ws, 'inside.txt'), join(ws, 'link-in'))
      symlink(other, join(ws, 'link-dir'))
      const ed = makeEditor(ws)
      // 指向工作区外 → 拒绝
      for (const p of ['link-out', 'link-dir/secret.txt']) {
        const a = ed.readAnchor({ path: p })
        t.check(a.ok === false, '外链应被拒: ' + p)
        t.check(a.error?.code === 'PATH_OUT_OF_SCOPE', '外链错误码错: ' + p)
      }
      t.check(readFile(other, 'secret.txt') === 'secret\n', '外链目标被改动了')
      // 指向工作区内的链接 → 受限档同样拒绝（不经 symlink 写：tmp+rename 会把链接替换成普通文件）
      const a = ed.readAnchor({ path: 'link-in' })
      t.check(a.ok === false, '区内链接应按受限档拒绝')
      t.check(a.error?.code === 'PATH_OUT_OF_SCOPE', '区内链接错误码应为 PATH_OUT_OF_SCOPE')
      const r = await ed.apply({ anchor: { path: 'link-in', exists: false, sha256: null }, newContent: 'inside v2\n', requestId: 'req-l10' })
      t.check(r.ok === false && r.error?.code === 'PATH_OUT_OF_SCOPE', '区内链接 apply 应被拒')
      t.check(readFile(ws, 'inside.txt') === 'inside\n', '区内链接的真实目标不应被改动')
      t.check(isSymlink(ws, 'link-in'), '被拒的写入不应把符号链接替换成普通文件')
    },
  },

  // ── L11 大文件 / 二进制 / 非法编码 ──
  {
    id: 'L11', title: '大文件、二进制、非法编码', criterion: '具名拒绝，不能偷偷截断或部分覆盖',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l11')
      const ed = makeEditor(ws, { limits: { maxFileBytes: 4096 } })
      writeFile(ws, 'big.txt', 'x'.repeat(9000))
      const big = ed.readAnchor({ path: 'big.txt' })
      t.check(big.ok === false && big.error?.code === 'FILE_TOO_LARGE', '大文件应具名拒绝，实得 ' + big.error?.code)
      // 二进制（NUL）
      writeFile(ws, 'bin.dat', Buffer.from([0x41, 0x00, 0x42, 0x43]))
      const bin = ed.readAnchor({ path: 'bin.dat' })
      t.check(bin.ok === false && bin.error?.code === 'UNSUPPORTED_ENCODING', '二进制应被拒，实得 ' + bin.error?.code)
      // 非法 UTF-8
      writeFile(ws, 'bad.txt', Buffer.from([0xC3, 0x28, 0x61]))
      const bad = ed.readAnchor({ path: 'bad.txt' })
      t.check(bad.ok === false && bad.error?.code === 'UNSUPPORTED_ENCODING', '非法 UTF-8 应被拒，实得 ' + bad.error?.code)
      // 对二进制文件发起 apply → 拒绝且不截断
      const before = snapshot(ws)
      const r = await ed.apply({ anchor: { path: 'bin.dat', exists: true, sha256: sha256(Buffer.from([0x41, 0x00, 0x42, 0x43])) }, newContent: 'zz\n', requestId: 'req-l11' })
      t.check(r.ok === false, '对二进制文件写入应被拒')
      const after = snapshot(ws)
      t.check(diffSnapshots(before, after).length === 0, '被拒的写入仍改变了磁盘')
    },
  },

  // ── L12 journal 保存失败 ──
  {
    id: 'L12', title: 'journal 保存失败', criterion: 'persistence 状态真实，不把「已保存可 Undo」虚报成成功',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l12')
      writeFile(ws, 'a.txt', 'v1\n')
      // 把 .malong/journal 做成普通文件 → createJournal 的 mkdir 必然失败（与 uid 无关）
      writeFile(ws, '.malong/journal', 'not-a-dir\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const before = readFile(ws, 'a.txt')
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l12' })
      t.check(r.ok === false, '日记落盘失败时不得报告成功')
      t.check(r.error?.code === 'PERSISTENCE_FAILED', '错误码应为 PERSISTENCE_FAILED，实得 ' + r.error?.code)
      t.check(r.receipt?.persistence === 'failed', '回执 persistence 应为 failed')
      t.check(r.receipt?.recovery?.supported === false, '没有落盘证据时不得承诺可 Undo')
      t.check(readFile(ws, 'a.txt') === before, '日记落盘失败时仍写了目标文件')
    },
  },

  // ── L13 kill -9 后重启 ──
  {
    id: 'L13', title: '写入过程 kill -9 后重启', criterion: '按现有日志三方状态识别，无法确认则 indeterminate',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l13')
      writeFile(ws, 'a.txt', 'v1\n')
      const child = join(HERE, 'child-apply.mjs')
      // ① 写日记后立刻被杀 → 文件未变 → reconcile 应判 not_applied
      const r1 = spawnSync(process.execPath, [child, ws, 'a.txt', 'v2\n', 'req-l13-a'], {
        env: { ...process.env, MALONG_LITE_TEST_KILL_AFTER_JOURNAL: '1' }, encoding: 'utf-8',
      })
      t.check(wasKilled(r1), '子进程应被 SIGKILL，实得 ' + (r1.signal || r1.status))
      const ed = makeEditor(ws)
      const txn1 = findLatestTxn(ws)
      t.check(!!txn1, '崩溃后应留下事务日记')
      const rec1 = ed.reconcile({ actionId: 'act-' + txn1 })
      t.check(rec1.receipt?.application === 'not_applied', '崩溃在写前应判 not_applied，实得 ' + rec1.receipt?.application)
      t.check(readFile(ws, 'a.txt') === 'v1\n', '崩溃在写前不应改文件')
      // ② 写完但未收口就被杀 → 文件已变 → reconcile 应判 applied
      const r2 = spawnSync(process.execPath, [child, ws, 'a.txt', 'v3\n', 'req-l13-b'], {
        env: { ...process.env, MALONG_LITE_TEST_KILL_AFTER_WRITE: '1' }, encoding: 'utf-8',
      })
      t.check(wasKilled(r2), '第二个子进程应被 SIGKILL')
      const txn2 = findLatestTxn(ws)
      const rec2 = ed.reconcile({ actionId: 'act-' + txn2 })
      t.check(rec2.receipt?.application === 'applied', '崩溃在写后应判 applied，实得 ' + rec2.receipt?.application)
      t.check(readFile(ws, 'a.txt') === 'v3\n', '崩溃在写后文件应已更新')
      // ③ 崩溃后文件又被外部改 → needs_review（不覆盖、不谎报）
      writeFile(ws, 'a.txt', 'external\n')
      const rec3 = ed.reconcile({ actionId: 'act-' + txn2 })
      t.check(rec3.receipt?.application === 'needs_review', '外部改动后应判 needs_review，实得 ' + rec3.receipt?.application)
      t.check(readFile(ws, 'a.txt') === 'external\n', 'reconcile 不得改盘')
      // ④ 无证据 → indeterminate
      const rec4 = ed.reconcile({ actionId: 'act-txn_does_not_exist' })
      t.check(rec4.receipt?.application === 'indeterminate', '无证据应判 indeterminate，实得 ' + rec4.receipt?.application)
    },
  },

  // ── L14 超时后仍有写入 ──
  {
    id: 'L14', title: '超时后仍有写入', criterion: '返回状态不得声称已取消且无副作用',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l14')
      writeFile(ws, 'a.txt', 'v1\n')
      const child = join(HERE, 'child-apply.mjs')
      const r1 = spawnSync(process.execPath, [child, ws, 'a.txt', 'v2\n', 'req-l14'], {
        env: { ...process.env, MALONG_LITE_TEST_KILL_AFTER_WRITE: '1' }, encoding: 'utf-8',
      })
      t.check(wasKilled(r1), '子进程应被杀（模拟写完但没收到响应）')
      t.check(readFile(ws, 'a.txt') === 'v2\n', '写入其实已经发生（副作用存在）')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const again = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l14' })
      t.check(again.ok === false, '同 request_id 的未收口重试不得盲目再执行')
      t.check(again.error?.code === 'INDETERMINATE', '应判 indeterminate（可能已写入），实得 ' + again.error?.code)
      t.check(readFile(ws, 'a.txt') === 'v2\n', '重试不得产生第二次写入')
    },
  },

  // ── L15 与土行孙 Cell 的不同工作区联调 ──
  {
    id: 'L15', title: '与土行孙 Cell 的不同工作区联调（经 Cell 适配层）', criterion: 'A 不能以模型参数指定 B 工作区；适配层拒绝一切工作区类入参',
    skipIf: (platform) => (platform === 'win32' ? 'Windows 创建符号链接需开发者模式/管理员特权，CI 上不可用' : null),
    async run(t) {
      const root = t.root
      const wsA = makeWorkspace(root, 'l15-A')
      const wsB = makeWorkspace(root, 'l15-B')
      writeFile(wsB, 'secret.txt', 'B-secret\n')
      // 按 Cell 的真实接法：工作区只由宿主钩子给出，模型只能给动作参数
      const cellA = createCellAdapter({ host: { workspaceRealPath: () => wsA } })

      // ① 模型层试图用工作区类入参换作用域 → 授权边界直接拒（不是「参数错误」）
      for (const k of ['workspace_dir', 'workspace', 'realPath', 'cwd']) {
        const r = cellA.readAnchor({ path: 'ok.txt', [k]: wsB })
        t.check(r.ok === false && r.error?.code === 'WORKSPACE_PARAM_FORBIDDEN', '传 ' + k + ' 应被授权边界拒: ' + JSON.stringify(r.error?.code))
        t.check(r.error?.handling?.retry === 'never', '授权边界不得标记为可重试: ' + k)
      }

      // ② 跨工作区路径 / 绝对路径 → PATH_OUT_OF_SCOPE
      const attempts = ['../l15-B/secret.txt', 'sub/../../l15-B/secret.txt', join(wsB, 'secret.txt')]
      for (const p of attempts) {
        const r = await cellA.apply({ anchor: { path: p, exists: false, sha256: null }, newContent: 'pwn\n', requestId: 'req-l15-' + p })
        t.check(r.ok === false, 'A 不得写 B 工作区: ' + p)
        t.check(r.error?.code === 'PATH_OUT_OF_SCOPE', '错误码应为 PATH_OUT_OF_SCOPE: ' + p)
      }

      // ③ A 内部放一个指向 B 的链接 → 同样拒绝（受限档拒绝一切经 symlink 的路径）
      symlink(join(wsB, 'secret.txt'), join(wsA, 'to-b'))
      const r2 = await cellA.apply({ anchor: { path: 'to-b', exists: false, sha256: null }, newContent: 'pwn\n', requestId: 'req-l15-link' })
      t.check(r2.ok === false && r2.error?.code === 'PATH_OUT_OF_SCOPE', '指向 B 的链接应被拒')

      // ④ B 确实没被动过（真实磁盘核对）
      t.check(readFile(wsB, 'secret.txt') === 'B-secret\n', 'B 工作区文件被改动了')
      t.check(!fileExists(wsB, 'pwn') && fileExists(wsB, 'secret.txt'), 'B 工作区出现意料之外的文件')
    },
  },

  // ── L16 不含 Rust parse 的独立装配 ──
  {
    id: 'L16', title: '不含 Rust parse 的独立装配', criterion: '缺 Rust 仍可完成这一闭环；否则明确依赖并改为 Adapter first 路线',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l16')
      writeFile(ws, 'a.txt', 'v1\n')
      const markerDir = join(t.root, 'l16-marker')
      const child = join(HERE, 'child-loop.mjs')
      const res = spawnSync(process.execPath, [child, ws, markerDir], { encoding: 'utf-8' })
      let out = null
      try { out = JSON.parse(res.stdout.trim().split('\n').pop()) } catch {}
      t.check(res.status === 0, '独立装配子进程失败: ' + (res.stderr || '').slice(0, 400))
      t.check(!!out, '子进程未输出结果')
      if (out) {
        t.check(out.loop_ok === true, '闭环未跑通: ' + JSON.stringify(out.steps))
        t.check(out.parser_invoked === false, 'Rust parser 被调用了（装配不独立）')
        t.check(out.index_db_created === false, '创建了代码索引 DB（装配不独立）')
      }
      // 真实磁盘证据：文件被改过又撤销回原样
      t.check(readFile(ws, 'a.txt') === 'v1\n', '独立装配后的最终磁盘内容不正确')
    },
  },

  // ── L17 外来 journal（edit_mode 不符）不得被接管撤销 ──
  {
    id: 'L17', title: '外来事务（edit_mode=write_symbol）拒绝 Undo', criterion: 'FOREIGN_JOURNAL，磁盘与日记字节级不变',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l17')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l17' })
      t.check(r.ok === true, 'apply 失败')
      const txn = r.detail.txn_id
      patchJournal(ws, txn, { manifest: { edit_mode: 'write_symbol' } })
      const before = journalSnapshot(ws, txn)

      const u = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l17-undo' })
      t.check(u.ok === false, '外来事务必须拒绝撤销（不得接管）')
      t.check(u.error?.code === 'FOREIGN_JOURNAL', '错误码应为 FOREIGN_JOURNAL，实得 ' + u.error?.code)
      t.check(u.error?.handling?.retry === 'never', '外来事务不得标记为可重试')
      t.check(u.detail?.reason === 'edit_mode_mismatch', 'detail.reason 应说明 edit_mode 不符，实得 ' + u.detail?.reason)
      t.check(readFile(ws, 'a.txt') === 'v2\n', '磁盘被改动了（拒绝必须零副作用）')
      const after = journalSnapshot(ws, txn)
      t.check(after.state === before.state, 'state.json 被改动了（拒绝必须不碰日记）')
      t.check(after.manifest === before.manifest, 'manifest.json 被改动了')
    },
  },

  // ── L18 未知格式 / 伪造发行者 / 身份不符，一律拒绝 ──
  {
    id: 'L18', title: '日记格式/发行者/身份不符', criterion: '三种伪造均 FOREIGN_JOURNAL，带具体 reason',
    async run(t) {
      const variants = [
        { name: 'journal_format=99', patch: { state: { journal_format: 99 } }, reason: 'format_unsupported' },
        { name: 'issuer=other-tool', patch: { state: { issuer: 'other-tool' } }, reason: 'issuer_mismatch' },
        { name: 'txn_id 不符', patch: { state: { txn_id: 'txn_0_deadbeef_p1' } }, reason: 'identity_mismatch' },
        // 缺字段同样是身份不明：不能因为「没写 txn_id」就跳过校验（伪造最容易走的路）
        { name: 'txn_id 缺失', patch: { state: { txn_id: undefined } }, reason: 'identity_mismatch' },
      ]
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i]
        const ws = makeWorkspace(t.root, 'l18-' + i)
        writeFile(ws, 'a.txt', 'v1\n')
        const ed = makeEditor(ws)
        const a = ed.readAnchor({ path: 'a.txt' })
        const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l18-' + i })
        patchJournal(ws, r.detail.txn_id, v.patch)
        const u = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l18-undo-' + i })
        t.check(u.ok === false, v.name + '：必须拒绝')
        t.check(u.error?.code === 'FOREIGN_JOURNAL', v.name + '：错误码应为 FOREIGN_JOURNAL，实得 ' + u.error?.code)
        t.check(u.detail?.reason === v.reason, v.name + '：reason 应为 ' + v.reason + '，实得 ' + u.detail?.reason)
        t.check(readFile(ws, 'a.txt') === 'v2\n', v.name + '：磁盘被改动了')
      }
      // 对照：合法（自己写的）日记必须照常可撤销，不能修成“什么都不让撤”
      const ws = makeWorkspace(t.root, 'l18-ok')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l18-ok' })
      const ok = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l18-ok-undo' })
      t.check(ok.ok === true, '合法日记的 undo 被误拒了')
      t.check(readFile(ws, 'a.txt') === 'v1\n', '合法 undo 未恢复文件')
    },
  },

  // ── L19 inspect / reconcile 不得读外来事务 ──
  {
    id: 'L19', title: 'inspect/reconcile 对外来事务拒绝', criterion: 'FOREIGN_JOURNAL，且不返回其它实现的内部事实',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l19')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l19' })
      patchJournal(ws, r.detail.txn_id, { manifest: { edit_mode: 'edit_batch' } })

      const ins = ed.inspect({ actionId: r.receipt.action_id })
      t.check(ins.ok === false, 'inspect 必须拒绝外来事务')
      t.check(ins.error?.code === 'FOREIGN_JOURNAL', 'inspect 错误码应为 FOREIGN_JOURNAL，实得 ' + ins.error?.code)
      t.check(ins.effect === undefined, 'inspect 不应返回外来事务的效果详情')

      const rec = ed.reconcile({ actionId: r.receipt.action_id })
      t.check(rec.ok === false, 'reconcile 必须拒绝外来事务')
      t.check(rec.error?.code === 'FOREIGN_JOURNAL', 'reconcile 错误码应为 FOREIGN_JOURNAL，实得 ' + rec.error?.code)
      t.check(rec.receipt === undefined, 'reconcile 不应为外来事务伪造回执')
    },
  },

  // ── L20 撤销后又被修改：再撤销不得覆盖后续改动 ──
  {
    id: 'L20', title: 'Undo 后又被人修改，再 Undo', criterion: '不覆盖后续修改；明确 already_undone',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l20')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l20' })
      const u1 = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l20-undo1' })
      t.check(u1.ok === true, '第一次 undo 失败: ' + JSON.stringify(u1.error))
      t.check(readFile(ws, 'a.txt') === 'v1\n', '第一次 undo 未恢复旧内容')

      writeFile(ws, 'a.txt', 'later-edit\n')
      const u2 = await ed.undo({ recoveryRef: r.receipt.recovery.ref, requestId: 'req-l20-undo2' })
      t.check(readFile(ws, 'a.txt') === 'later-edit\n', '第二次 undo 覆盖了后续修改')
      t.check(u2.ok === true && u2.detail?.liuhe_code === 'already_undone', '应明确回报 already_undone，实得 ' + JSON.stringify(u2.detail))

      // 撤销后 reconcile 必须说“提交过又撤销”，不能说“从未落地”
      const rec = ed.reconcile({ actionId: r.receipt.action_id })
      t.check(rec.receipt?.application === 'not_applied', '撤销后净效果应为 not_applied')
      t.check(/undone/.test(rec.receipt?.extension?.reason || ''), 'reason 必须写明是撤销，而不是从未发生')
    },
  },

  // ── L21 路径脱敏：URL 不能被误伤，Windows/空格路径要盖住 ──
  {
    id: 'L21', title: '路径脱敏与 URL 误伤', criterion: 'URL 原样保留；绝对路径/Windows/引号含空格路径均降级',
    async run(t) {
      const url = 'see https://example.com/a/b for details'
      t.check(redactPaths(url) === url, 'URL 被误改了: ' + redactPaths(url))
      t.check(redactPaths('镜像 file:///home/me/x.txt 结束').includes('file:///home/me/x.txt'), 'file:// URL 被误改')
      // 非 http 协议同样不能被当成路径（0.1.0 同类误伤的另一面）
      t.check(redactPaths('clone ssh://git@host/a/b now').includes('ssh://git@host/a/b'), 'ssh:// URL 被误改')
      t.check(redactPaths('db postgres://u@h:5432/x/y end').includes('postgres://u@h:5432/x/y'), 'postgres:// URL 被误改')

      const winOut = redactPaths('open C:\\Users\\me\\secret.txt now')
      t.check(winOut.includes('<path>'), 'Windows 盘符路径未降级: ' + winOut)
      t.check(!winOut.includes('secret'), 'Windows 路径内容泄露: ' + winOut)

      const quoted = redactPaths('at "C:\\Program Files\\app\\x.log" now')
      t.check(quoted.includes('"<path>"'), '引号含空格路径未整体降级: ' + quoted)

      t.check(redactPaths('share \\\\server\\share\\f.txt').includes('<path>'), 'UNC 路径未降级')

      const ws = makeWorkspace(t.root, 'l21')
      const abs = join(ws, 'my file.txt')
      const out = redactPaths('failed at ' + abs, ws)
      t.check(out.includes('<workspace>'), '工作区根未降级: ' + out)
      t.check(!out.includes(ws), '工作区绝对路径泄露: ' + out)
      t.check(out.includes('my file.txt'), '工作区内的相对部分应保留（可诊断）: ' + out)

      t.check(redactPaths('/etc/passwd').includes('<path>'), 'POSIX 绝对路径未降级')
      t.check(redactPaths(null) === '', 'null 应返回空串')
    },
  },

  // ── L22 错误合同完整性（码↔处置表↔形状）──
  {
    id: 'L22', title: '错误合同完整性', criterion: '每个码都有 retry 策略；原生错误带 handling 且 detail 在顶层',
    async run(t) {
      for (const code of Object.values(LiteErrorCodes)) {
        const p = RETRY_POLICY[code]
        t.check(!!p, '错误码缺处置策略: ' + code)
        if (p) t.check(RETRY_VALUES.includes(p.retry), code + ' 的 retry 取值非法: ' + p.retry)
      }
      for (const [code, p] of Object.entries(RETRY_POLICY)) {
        t.check(RETRY_VALUES.includes(p.retry), code + ' 的 retry 取值非法: ' + p.retry)
        t.check(typeof p.note === 'string' && p.note.length > 0, code + ' 缺 note')
      }

      const ws = makeWorkspace(t.root, 'l22')
      const ed = makeEditor(ws)
      const e = ed.readAnchor({ path: '../escape' })
      t.check(e.ok === false, '越界读应失败')
      t.check(!!e.error?.handling, '原生错误必须自带 handling')
      t.check(RETRY_VALUES.includes(e.error?.handling?.retry), 'handling.retry 取值非法')
      t.check('detail' in e && !('detail' in e.error), 'detail 必须在顶层，不能嵌在 error 里')

      // 适配层错误：同一合同面（不能只有示例适配层自己补 handling）
      const ad = createCellAdapter({ host: { workspaceRealPath: () => ws } })
      const bad = await ad.apply({ workspace_dir: ws, anchor: { path: 'a.txt' }, newContent: 'x' })
      t.check(bad.ok === false && bad.error?.code === 'WORKSPACE_PARAM_FORBIDDEN', '适配层未拦工作区入参')
      t.check(bad.error?.handling?.retry === 'never', '适配层错误缺 handling')

      // 结构守卫：所有失败对象必须由 liteError 构造。历史教训：apply/undo/reconcile 曾用 5 处手写
      // 对象绕过统一形状，而这些路径恰好没有对应用例，L22 当时全绿——只测 liteError 路径测不出这类洞。
      for (const f of ['index.js', 'receipt.js']) {
        const src = readFileSync(join(HERE, '../lite', f), 'utf-8')
        t.check(!/\berror:\s*\{/.test(src), f + ' 里出现手写 error 对象（应统一走 liteError）')
      }

      // 失败也要带证据：适配层不能把原生 receipt 吃掉（过一层就只剩一句话，Cell 无法核实）
      writeFile(ws, 'r.txt', 'v1\n')
      const ed2 = makeEditor(ws)
      const a2 = ed2.readAnchor({ path: 'r.txt' })
      const ap2 = await ed2.apply({ anchor: a2.anchor, newContent: 'v2\n', requestId: 'l22-receipt' })
      t.check(ap2.ok === true, 'L22 前置 apply 失败')
      writeFile(ws, 'r.txt', 'v3-external\n')
      const ad2 = createCellAdapter({ host: { workspaceRealPath: () => ws } })
      const rc = ad2.reconcile({ actionId: ap2.receipt.action_id })
      t.check(rc.ok === false && rc.error?.code === 'NEEDS_REVIEW', '适配层 reconcile 应透出 NEEDS_REVIEW: ' + JSON.stringify(rc.error))
      t.check(rc.error?.handling?.retry === 'never', '适配层错误缺 handling')
      t.check(!!rc.receipt, '适配层把原生 receipt 丢了（Cell 只剩一句话，没有证据）')

      // 二进制内容不进 Lite：写进去能成功，但之后 readAnchor 会拒读——自己造一个 Lite 管不了的文件
      const aNul = ed2.readAnchor({ path: 'r.txt' })
      const nulRes = await ed2.apply({ anchor: aNul.anchor, newContent: 'a\u0000b', requestId: 'l22-nul' })
      t.check(nulRes.ok === false && nulRes.error?.code === 'INVALID_INPUT', '二进制内容应 INVALID_INPUT: ' + JSON.stringify(nulRes.error))
      t.check(!!nulRes.error?.handling, 'NUL 拒绝也必须带 handling')
      t.check(ed2.preview({ anchor: aNul.anchor, newContent: 'a\u0000b' }).ok === false, 'preview 也应拒绝二进制内容')
      t.check(readFile(ws, 'r.txt') === 'v3-external\n', '拒绝二进制不得改盘')
    },
  },

  // ── L23 多进程同时 undo 同一事务 ──
  {
    id: 'L23', title: '多进程同时 Undo 同一事务', criterion: '磁盘回到旧版本（不重复回滚），无进程崩溃，拒绝理由具名',
    async run(t) {
      const ws = makeWorkspace(t.root, 'l23')
      writeFile(ws, 'a.txt', 'v1\n')
      const ed = makeEditor(ws)
      const a = ed.readAnchor({ path: 'a.txt' })
      const r = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'req-l23' })
      t.check(r.ok === true, 'apply 失败')
      const ref = r.receipt.recovery.ref
      const child = join(HERE, 'child-undo.mjs')
      const runChild = (reqId) => new Promise((resolve) => {
        const p = spawn(process.execPath, [child, ws, ref, reqId], { env: process.env })
        let out = ''
        p.stdout.on('data', (d) => { out += d })
        p.stderr.on('data', (d) => { out += d })
        p.on('close', (code) => {
          let parsed = null
          try { parsed = JSON.parse(out.trim().split('\n').pop()) } catch {}
          resolve({ code, out, parsed })
        })
      })
      const rs = await Promise.all([runChild('req-l23-a'), runChild('req-l23-b')])
      for (const [i, c] of rs.entries()) {
        t.check(c.code === 0, '子进程 ' + i + ' 异常退出: ' + c.out.slice(0, 300))
        t.check(!!c.parsed, '子进程 ' + i + ' 未输出可解析结果')
      }
      t.check(rs.some((x) => x.parsed?.ok === true), '两个进程都没成功撤销（不应如此）')
      // 拒绝必须是具名的（already_undone / UNDO_CONFLICT / FILE_LOCKED），不能是未分类崩溃
      for (const x of rs.filter((y) => y.parsed && y.parsed.ok === false)) {
        t.check(['UNDO_CONFLICT', 'FILE_LOCKED', 'INDETERMINATE', 'RECOVERY_UNAVAILABLE'].includes(x.parsed.code),
          '拒绝理由不具名: ' + JSON.stringify(x.parsed))
      }
      t.check(readFile(ws, 'a.txt') === 'v1\n', '多进程 undo 后磁盘应为旧版本，实得 ' + JSON.stringify(readFile(ws, 'a.txt')))
    },
  },
]

// ── L24 Undo 的 request_id 语义（幂等复读 / 异事务冲突）──
CASES.push({
  id: 'L24', title: 'Undo 的 request_id 幂等与归属',
  criterion: '同 id 重试必须复读原回执（不重复撤销、不改写账本）；同 id 指向另一事务必须 REQUEST_CONFLICT 且不碰盘',
  async run(t) {
    const ws = makeWorkspace(t.root, 'l24')
    writeFile(ws, 'a.txt', 'v1\n')
    writeFile(ws, 'b.txt', 'b1\n')
    const ed = makeEditor(ws)
    const a1 = ed.readAnchor({ path: 'a.txt' })
    const ap1 = await ed.apply({ anchor: a1.anchor, newContent: 'v2\n', requestId: 'l24-apply-a' })
    const a2 = ed.readAnchor({ path: 'b.txt' })
    const ap2 = await ed.apply({ anchor: a2.anchor, newContent: 'b2\n', requestId: 'l24-apply-b' })
    t.check(ap1.ok === true && ap2.ok === true, '前置 apply 失败: ' + JSON.stringify(ap1.error || ap2.error))

    const u1 = await ed.undo({ recoveryRef: 'liuhe-undo:' + ap1.detail.txn_id, requestId: 'l24-undo' })
    t.check(u1.ok === true, '首次 undo 应成功: ' + JSON.stringify(u1.error))
    t.check(readFile(ws, 'a.txt') === 'v1\n', '首次 undo 未恢复旧内容')
    t.check(u1.detail?.idempotent_replay !== true, '首次 undo 不应标记为复读')

    // 同 id 重试：必须是「复读原回执」，不能第二次跑 restoreJournal
    const u2 = await ed.undo({ recoveryRef: 'liuhe-undo:' + ap1.detail.txn_id, requestId: 'l24-undo' })
    t.check(u2.ok === true, '同 id 重试应幂等成功: ' + JSON.stringify(u2.error))
    t.check(u2.detail?.idempotent_replay === true, '同 id 重试必须标记 idempotent_replay（否则等于谎称又撤销了一次）')
    t.check(u2.receipt?.effect?.after_sha256 === u1.receipt?.effect?.after_sha256, '复读回执与首次回执不一致（账本被改写）')
    t.check(readFile(ws, 'a.txt') === 'v1\n', '重试后磁盘不应变化')

    // 同 id 指向另一事务：必须拒绝，且 b.txt 保持 b2（不许被撤销）
    const u3 = await ed.undo({ recoveryRef: 'liuhe-undo:' + ap2.detail.txn_id, requestId: 'l24-undo' })
    t.check(u3.ok === false && u3.error?.code === 'REQUEST_CONFLICT',
      '同 id 异事务应 REQUEST_CONFLICT，实得 ' + JSON.stringify(u3.error))
    t.check(!!u3.error?.handling, '冲突错误必须带 handling')
    t.check(readFile(ws, 'b.txt') === 'b2\n', '冲突请求不得撤销另一个事务（b.txt 被改动了）')
  },
})

// ── L25 失败/结论的错误形状（ok:false ⇒ error{code,handling}）──
CASES.push({
  id: 'L25', title: 'reconcile 结论与失败形状',
  criterion: 'ok:false 必须带 error{code,handling}；needs_review 与 indeterminate 要区分；证据不可读时不得谎称「从未发生」',
  async run(t) {
    const ws = makeWorkspace(t.root, 'l25')
    writeFile(ws, 'a.txt', 'v1\n')
    const ed = makeEditor(ws)
    const a = ed.readAnchor({ path: 'a.txt' })
    const ap = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'l25-apply' })
    t.check(ap.ok === true, '前置 apply 失败')
    const txn = ap.detail.txn_id

    // 1) 外部改成第三态 → needs_review（既不说 applied，也不说「没发生过」）
    writeFile(ws, 'a.txt', 'v3-external\n')
    const r1 = ed.reconcile({ actionId: 'act-' + txn })
    t.check(r1.ok === false, 'needs_review 不应报 ok:true')
    t.check(r1.receipt?.application === 'needs_review', '应判 needs_review，实得 ' + r1.receipt?.application)
    t.check(r1.error?.code === 'NEEDS_REVIEW', 'needs_review 应有具名错误码，实得 ' + JSON.stringify(r1.error))
    t.check(r1.error?.handling?.retry === 'never', 'needs_review 的处置必须是 never（重试不会自愈）')
    t.check(!!r1.receipt, 'needs_review 仍须返回回执（Cell 需要证据）')

    // 2) 撤销失败（外部改动）→ UNDO_CONFLICT，且必须带 handling
    const uc = await ed.undo({ recoveryRef: 'liuhe-undo:' + txn, requestId: 'l25-undo-conflict' })
    t.check(uc.ok === false && uc.error?.code === 'UNDO_CONFLICT', '外部改动后 undo 应 UNDO_CONFLICT: ' + JSON.stringify(uc.error))
    t.check(uc.error?.handling?.retry === 'never', 'UNDO_CONFLICT 必须带 handling（此前裸奔）')
    t.check(readFile(ws, 'a.txt') === 'v3-external\n', '撤销失败不得改动文件')

    // 3) 证据不可读（state.json 坏）→ 结论未定，且不得声称 persisted
    const p = join(ws, '.malong', 'journal', txn, 'state.json')
    writeFileSync(p, '{ this is not json')
    const r2 = ed.reconcile({ actionId: 'act-' + txn })
    t.check(r2.ok === false, '证据不可读不应报 ok:true')
    t.check(r2.error?.code === 'INDETERMINATE', '应为 INDETERMINATE，实得 ' + JSON.stringify(r2.error))
    t.check(!!r2.error?.handling, 'INDETERMINATE 必须带 handling（此前这里裸奔）')
    t.check(r2.receipt?.persistence !== 'persisted', '证据不可读时不得声称 persisted，实得 ' + r2.receipt?.persistence)
    t.check(r2.receipt?.application !== 'not_applied', '证据不可读时不得判 not_applied（等于谎称从未发生）')

    // 4) inspect 同场景：RECOVERY_UNAVAILABLE，且不改盘
    const before = snapshot(ws)
    const i1 = ed.inspect({ actionId: 'act-' + txn })
    t.check(i1.ok === false && i1.error?.code === 'RECOVERY_UNAVAILABLE',
      'inspect 证据不可读应 RECOVERY_UNAVAILABLE: ' + JSON.stringify(i1.error))
    t.check(!!i1.error?.handling, 'inspect 错误缺 handling')
    t.check(diffSnapshots(before, snapshot(ws)).length === 0, 'inspect 不得改盘')
  },
})

// ── L26 边界：过期口径 / 伪日记作用域 / 暴涨文件有界 ──
CASES.push({
  id: 'L26', title: '过期口径 / 日记路径作用域 / 读取有界',
  criterion: '过期时间从日记时刻算；日记里的越界路径 fail-closed 且不泄露元数据；锚点后暴涨的文件不得整读',
  async run(t) {
    // 1) 过期口径：必须从 committed_at 算，不能拿「现在 + 24h」冒充
    const ws = makeWorkspace(t.root, 'l26')
    writeFile(ws, 'a.txt', 'v1\n')
    const ed = makeEditor(ws)
    const a = ed.readAnchor({ path: 'a.txt' })
    const ap = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'l26-apply' })
    t.check(ap.ok === true, '前置 apply 失败')
    const txn = ap.detail.txn_id
    const fresh = ed.inspect({ actionId: 'act-' + txn })
    t.check(fresh.effect?.undo_expired === false, '新动作不应判过期')
    t.check(fresh.effect?.undo_supported === true, '新动作应可撤销')
    const committedMs = Date.parse(JSON.parse(readFileSync(join(ws, '.malong', 'journal', txn, 'state.json'), 'utf-8')).committed_at)
    const deltaH = (Date.parse(fresh.effect.undo_expires_at) - committedMs) / 3600000
    t.check(Math.abs(deltaH - 24) < 0.1, '过期时间应是 committed_at + 24h，实际偏差 ' + deltaH.toFixed(2) + 'h（0.1.1 曾是 now + 24h）')

    patchJournal(ws, txn, { state: { committed_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() } })
    const old = ed.inspect({ actionId: 'act-' + txn })
    t.check(old.effect?.undo_expired === true, '30h 前的动作应判过期，实得 undo_expired=' + old.effect?.undo_expired)
    t.check(old.effect?.undo_supported === false, '过期动作不得再承诺 Undo')
    t.check(Date.parse(old.effect.undo_expires_at) < Date.now(), '过期时间不得落在未来')

    // 2) 不可读日记：撤销必须 fail-closed（不能交给 restoreJournal 去猜）
    writeFileSync(join(ws, '.malong', 'journal', txn, 'state.json'), '{ not json')
    const u = await ed.undo({ recoveryRef: 'liuhe-undo:' + txn, requestId: 'l26-undo-bad' })
    t.check(u.ok === false && u.error?.code === 'RECOVERY_UNAVAILABLE', '不可读日记应拒绝撤销: ' + JSON.stringify(u.error))
    t.check(!!u.error?.handling, '拒绝必须带 handling')
    t.check(readFile(ws, 'a.txt') === 'v2\n', '拒绝撤销不得改动文件')

    // 3) 伪造日记：manifest.file 越界 → 三个动作都拒绝，且不读工作区外文件
    const wf = makeWorkspace(t.root, 'l26-forged')
    const outside = join(t.root, 'l26-secret.txt')
    writeFileSync(outside, 'TOP-SECRET')
    const ftxn = 'txn_0_deadbeef_f1'
    writeFile(wf, '.malong/journal/' + ftxn + '/manifest.json', JSON.stringify({ txn_id: ftxn, file: '../../l26-secret.txt', edit_mode: 'lite_replace' }))
    writeFile(wf, '.malong/journal/' + ftxn + '/state.json', JSON.stringify({ txn_id: ftxn, state: 'committed', issuer: 'liuhe-lite', journal_format: 1, new_hash: null }))
    const fe = makeEditor(wf)
    const beforeF = snapshot(wf)
    const fi = fe.inspect({ actionId: 'act-' + ftxn })
    t.check(fi.ok === false && fi.error?.code === 'FOREIGN_JOURNAL', '越界 manifest 应 FOREIGN_JOURNAL: ' + JSON.stringify(fi.error))
    t.check(fi.detail?.reason === 'path_out_of_scope', '应说明越界，实得 ' + JSON.stringify(fi.detail))
    t.check(!('current_sha256' in (fi.effect || {})), '不得泄露工作区外文件元数据')
    const fr = fe.reconcile({ actionId: 'act-' + ftxn })
    t.check(fr.ok === false && fr.error?.code === 'FOREIGN_JOURNAL', 'reconcile 也应拒绝，实得 ' + JSON.stringify(fr.error))
    const fu = await fe.undo({ recoveryRef: 'liuhe-undo:' + ftxn, requestId: 'l26-undo-forged' })
    t.check(fu.ok === false && fu.error?.code === 'FOREIGN_JOURNAL', 'undo 应拒绝，实得 ' + JSON.stringify(fu.error))
    t.check(readFileSync(outside, 'utf-8') === 'TOP-SECRET', '不得改动工作区外文件')
    t.check(diffSnapshots(beforeF, snapshot(wf)).length === 0, '拒绝不得改盘')

    // 4) 读取有界：锚点后文件暴涨 300 MiB → 必须快速判冲突，且不整读
    const child = join(HERE, 'child-bounded.mjs')
    const rc = spawnSync(process.execPath, [child], { env: process.env, encoding: 'utf-8', timeout: 120000 })
    t.check(rc.status === 0, '有界性子进程失败: ' + String(rc.stderr || '').slice(0, 300))
    let j = null
    try { j = JSON.parse(String(rc.stdout || '').trim().split('\n').pop()) } catch {}
    t.check(!!j, '有界性子进程未输出可解析结果')
    if (j) {
      t.check(j.ok === false && j.code === 'VERSION_CONFLICT', '锚点后暴涨应判 VERSION_CONFLICT，实得 ' + j.code)
      t.check(j.jump === null || j.jump < 128, '锚点后 300MiB 暴涨使进程峰值 +' + j.jump + 'MiB（应 < 128；0.1.1 是整读）')
    }
  },
})

// ── L27 过期自动清扫（土行孙 A-1：SAFETY 承诺的「24h 过期自动清扫」此前只写在文档里）──
CASES.push({
  id: 'L27', title: '过期日记自动清扫（只清自己的）',
  criterion: 'apply 后过期的已提交事务被清扫；needs_review/在途永不自动删；外来日记一律不碰',
  async run(t) {
    const ws = makeWorkspace(t.root, 'l27')
    writeFile(ws, 'a.txt', 'v1\n')
    writeFile(ws, 'b.txt', 'b1\n')
    const ed = makeEditor(ws)
    const a1 = ed.readAnchor({ path: 'a.txt' })
    const ap1 = await ed.apply({ anchor: a1.anchor, newContent: 'v2\n', requestId: 'l27-a' })
    const a2 = ed.readAnchor({ path: 'b.txt' })
    const ap2 = await ed.apply({ anchor: a2.anchor, newContent: 'b2\n', requestId: 'l27-b' })
    t.check(ap1.ok === true && ap2.ok === true, '前置 apply 失败')
    const oldTxn = ap1.detail.txn_id
    const keepTxn = ap2.detail.txn_id

    // a：30h 前提交（应被清扫）；b：30h 前但 needs_review（永不自动删）
    patchJournal(ws, oldTxn, { state: { committed_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() } })
    patchJournal(ws, keepTxn, {
      state: { state: 'needs_review', committed_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() },
    })

    // 外来日记（产品写路径的 edit_mode）：再老也不是 Lite 的，不得碰
    const ftxn = 'txn_0_l27_foreign'
    writeFile(ws, '.malong/journal/' + ftxn + '/manifest.json',
      JSON.stringify({ txn_id: ftxn, file: 'a.txt', edit_mode: 'write_symbol' }))
    writeFile(ws, '.malong/journal/' + ftxn + '/state.json',
      JSON.stringify({ txn_id: ftxn, state: 'committed', committed_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString() }))

    // 再跑一次 apply（触发清扫）
    writeFile(ws, 'c.txt', 'c1\n')
    const a3 = ed.readAnchor({ path: 'c.txt' })
    const ap3 = await ed.apply({ anchor: a3.anchor, newContent: 'c2\n', requestId: 'l27-c' })
    t.check(ap3.ok === true, '触发 apply 失败: ' + JSON.stringify(ap3.error))

    const gone = !fileExists(ws, '.malong/journal/' + oldTxn)
    t.check(gone, '30h 前的已提交事务应被自动清扫（SAFETY §6 的承诺）')
    t.check(fileExists(ws, '.malong/journal/' + keepTxn), 'needs_review 的事务不得被自动删')
    t.check(fileExists(ws, '.malong/journal/' + ftxn), '外来日记（write_symbol）不得被 Lite 清扫')
    t.check(readFile(ws, 'a.txt') === 'v2\n', '清扫只动日记，不动文件')
  },
})

// ── L28 过期口径一致性（土行孙 A-2：inspect 说不能撤、undo 却真撤了）──
CASES.push({
  id: 'L28', title: '过期事务的 inspect / undo / reconcile 同一口径',
  criterion: '过期后三处都不得承诺或执行撤销；拒绝必须具名（undo_expired）且不改盘',
  async run(t) {
    const ws = makeWorkspace(t.root, 'l28')
    writeFile(ws, 'a.txt', 'v1\n')
    const ed = makeEditor(ws)
    const a = ed.readAnchor({ path: 'a.txt' })
    const ap = await ed.apply({ anchor: a.anchor, newContent: 'v2\n', requestId: 'l28-a' })
    t.check(ap.ok === true, '前置 apply 失败')
    const txn = ap.detail.txn_id

    // 未过期：三处一致可撤
    const freshIns = ed.inspect({ actionId: 'act-' + txn })
    t.check(freshIns.effect?.undo_supported === true, '未过期应可撤销')
    const freshRec = ed.reconcile({ actionId: 'act-' + txn })
    t.check(freshRec.receipt?.recovery?.supported === true, '未过期 reconcile 也应承诺可撤销（同一事实只写一处）')

    // 过期：inspect / undo / reconcile 三处必须一致
    patchJournal(ws, txn, { state: { committed_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() } })
    const oldIns = ed.inspect({ actionId: 'act-' + txn })
    t.check(oldIns.effect?.undo_expired === true && oldIns.effect?.undo_supported === false, 'inspect 应判过期且不可撤')
    const oldRec = ed.reconcile({ actionId: 'act-' + txn })
    t.check(oldRec.receipt?.recovery?.supported === false, '过期后 reconcile 不得承诺可撤销（0.1.2 只改了 inspect，这层漏了）')

    const u = await ed.undo({ recoveryRef: 'liuhe-undo:' + txn, requestId: 'l28-undo' })
    t.check(u.ok === false, '过期事务 undo 必须拒绝（0.1.2 会真撤掉，与 inspect 矛盾）')
    t.check(u.error?.code === 'NOT_UNDOABLE', '过期应归 NOT_UNDOABLE，实得 ' + JSON.stringify(u.error))
    t.check(u.detail?.reason === 'undo_expired', '拒绝必须具名 undo_expired，实得 ' + JSON.stringify(u.detail))
    t.check(!!u.error?.handling, '过期拒绝也必须带 handling')
    t.check(readFile(ws, 'a.txt') === 'v2\n', '过期拒绝不得改盘')

    // 幂等复读不受过期影响：先撤成功（未过期窗口内），再把时间推老，同 id 重试仍复读原回执
    const ws2 = makeWorkspace(t.root, 'l28b')
    writeFile(ws2, 'b.txt', 'v1\n')
    const ed2 = makeEditor(ws2)
    const b = ed2.readAnchor({ path: 'b.txt' })
    const bp = await ed2.apply({ anchor: b.anchor, newContent: 'v2\n', requestId: 'l28-b' })
    const u1 = await ed2.undo({ recoveryRef: 'liuhe-undo:' + bp.detail.txn_id, requestId: 'l28-undo-2' })
    t.check(u1.ok === true, '前置 undo 失败')
    patchJournal(ws2, bp.detail.txn_id, { state: { committed_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() } })
    const u2 = await ed2.undo({ recoveryRef: 'liuhe-undo:' + bp.detail.txn_id, requestId: 'l28-undo-2' })
    t.check(u2.ok === true && u2.detail?.idempotent_replay === true, '已成功的撤销重试应复读原回执（过期拒绝只挡新执行，不改写历史）')
  },
})
