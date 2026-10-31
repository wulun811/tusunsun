// 从 .tgz 读**成员清单**，不经外部 `tar`。
//
// 为什么不用 `tar -tzf`：它的输出是**面向终端**的，会按 locale 把非 ASCII 文件名转成
// `\345\244\207...` 这样的八进制转义。登记清单里存的是 Unicode 原名，于是"集合相等"
// 在 GNU tar + 某些 locale 下会假红（rc.21 反例 02 实测 2/3，其中成员清单那条是假红，
// `TAR_OPTIONS=--quoting-style=literal` 才 3/3）。判据不该依赖一个展示层的引用方式 ——
// 那会让"这条测试是不是绿的"取决于跑它的人用的 tar 版本和 locale。
//
// 这里按 ustar/POSIX 格式直接读头块：名字是原始字节，`toString('utf8')` 就是真名。
// 只实现"读清单"需要的最小面：512 字节头块、`name`(0..100)、`prefix`(345..500)、
// `size`(124..136, 八进制)、`typeflag`(156)、GNU 长名（'L'）与 PAX 头（'x'/'g'）跳过。
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

function cstr(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString('utf8');
}

/** size 字段可能是 base-256（大文件）或八进制；两者都要认。 */
function parseSize(buf, off) {
  const first = buf[off];
  if (first & 0x80) {                       // GNU base-256
    let v = 0;
    for (let i = 1; i < 12; i++) v = v * 256 + buf[off + i];
    return v;
  }
  const s = cstr(buf, off, 12).trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * @param {Buffer} tgz 未解压的 .tgz/.tar.gz 字节
 * @returns {{name:string,size:number,type:string}[]} 成员（含目录项，按归档顺序）
 */
export function listTgzMembers(tgz) {
  const tar = tgz[0] === 0x1f && tgz[1] === 0x8b ? gunzipSync(tgz) : tgz;
  const out = [];
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + BLOCK <= tar.length) {
    const block = tar.subarray(off, off + BLOCK);
    // 全零块 = 归档结束（POSIX 要求两个，但一个就够了）
    if (block.every((b) => b === 0)) break;
    const type = String.fromCharCode(tar[off + 156] || 0x30);
    const size = parseSize(tar, off + 124);
    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    const next = off + BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') { longName = cstr(body, 0, body.length); off = next; continue; }
    if (type === 'x') { paxPath = parsePaxPath(body) ?? paxPath; off = next; continue; }
    if (type === 'g') { off = next; continue; }

    const name = cstr(tar, off, 100);
    const prefix = cstr(tar, off + 345, 155);
    const full = longName || paxPath || (prefix ? `${prefix}/${name}` : name);
    // 目录项：typeflag '5'，或名字以 / 结尾。归档里的目录不参与"成员比对"，但要能看见。
    out.push({ name: full.replace(/\/+$/, ''), size, type, isDir: type === '5' || /\/$/.test(full) });
    longName = null; paxPath = null;
    off = next;
  }
  return out;
}

/** PAX 扩展头里 `path=` 记录；解不出返回 null。 */
function parsePaxPath(body) {
  let i = 0;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) return null;
    const len = parseInt(body.toString('utf8', i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) return null;
    const rec = body.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq !== -1 && rec.slice(0, eq) === 'path') return rec.slice(eq + 1);
    i += len;
  }
  return null;
}

/** 只取普通文件成员名（不含目录项），按字符序排序 —— 与 baseline 的 checked_members 同口径。 */
export function listTgzFiles(tgz) {
  return listTgzMembers(tgz).filter((m) => !m.isDir).map((m) => m.name.replace(/^package\//, '')).sort();
}
