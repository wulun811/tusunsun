// JSON5 加载器 — 注释、无引号键、尾随逗号（明确子集，不假装完整 JSON5）。
//
// 必须在**一次状态机扫描**里同时处理字符串外的 `//` 与 `/* */`、标识符裸键、尾随逗号
// 与单/双引号字符串（含转义）：这些判断共享同一个事实 —— "当前是否在字符串内"。
// 拆成几次正则或几遍扫描，字符串内部的字节就会被改写（`"a /* b */ c"` 被吞掉），
// 或者靠扫描顺序侥幸让 `http://` 活下来。
// 超出子集由 JSON.parse 报错并带位置，不静默改写。

const IDENT = /^[A-Za-z_$][\w$]*/;

/**
 * 解析 JSON5 子集，返回对象（不是 JSON 文本）。
 *
 * 一次扫描做四件事：① 跳过字符串外的注释；② 单引号串转双引号并补转义；
 * ③ 删字符串外的尾逗号；④ 给处于键位置的标识符加引号。
 * 拆成多个函数各扫一遍，就是在四个地方重复同一个状态判断。
 */
export function loadJson5(raw) {
  if (typeof raw !== 'string') throw new Error('Invalid scene config: 输入必须是字符串');
  let out = '';
  let i = 0;
  let last = '';                     // 上一个非空白字符：判断"这里是不是键位置"
  const n = raw.length;

  while (i < n) {
    const ch = raw[i];

    // ── 字符串：整段搬运，只在两端换引号 ──
    if (ch === '"' || ch === "'") {
      const q = ch;
      out += '"';
      i++;
      while (i < n) {
        const c = raw[i];
        if (c === '\\') {   // `\'` 在 JSON 里非法，单引号串里译成字面 '；其余原样搬运交给 JSON.parse
          const nx = raw[i + 1];
          out += (q === "'" && nx === "'") ? "'" : c + (nx ?? '');
          i += nx === undefined ? 1 : 2;
          continue;
        }
        if (c === q) { out += '"'; i++; break; }
        out += c === '"' ? '\\"' : c;   // 单引号串内部的 " 需要转义
        i++;
      }
      last = '"';
      continue;
    }

    // ── 注释：只在字符串外识别 ──
    if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      const end = raw.indexOf('\n', i + 2);
      i = end < 0 ? n : end;          // 保留换行
      continue;
    }

    // ── 闭合符：先把它前面悬着的尾逗号抹掉 ──
    // 不能用"向前看 raw"的写法：逗号后面可能跟着注释，raw 里看到的是 '/' 而不是 '}'，
    // 改为回看**已输出**的内容：注释已被跳过，所以 out 里逗号与闭合符之间只有空白。
    if (ch === '}' || ch === ']') {
      const trimmed = out.replace(/\s+$/, '');
      if (trimmed.endsWith(',')) out = trimmed.slice(0, -1);
    }

    // ── 裸键：键位置上的标识符且后面紧跟 ':' ──
    if ((last === '{' || last === ',') && IDENT.test(ch)) {
      const m = IDENT.exec(raw.slice(i));
      if (/^\s*:/.test(raw.slice(i + m[0].length))) {
        out += `"${m[0]}"`;
        i += m[0].length;
        last = '"';
        continue;
      }
    }

    out += ch;
    if (!/\s/.test(ch)) last = ch;
    i++;
  }

  try { return JSON.parse(out); }
  catch (e) { throw new Error(`Invalid scene config: ${e.message}`); }
}
