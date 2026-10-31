#!/usr/bin/env node
/**
 * verification/model/fetch-tlc.mjs —— 下载 TLC 并校验 sha256
 *
 * 为什么要有这个文件：模型检查的结果只能对**确定的那一个工具**成立。
 * 一句「用 TLC 跑过」在工具版本、jar 来源、hash 都不确定时，等于什么都没说。
 *
 *   node verification/model/fetch-tlc.mjs            # 下载到 .tools/ 并校验
 *   node verification/model/fetch-tlc.mjs --check    # 只校验已有文件
 *
 * 校验不过就不落盘（或直接报错）。没有网的环境用 TLA2TOOLS_JAR 指到已校验的副本。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIN_FILE = join(HERE, 'tla2tools.jar.sha256');
const OUT_DIR = join(HERE, '.tools');
const OUT = join(OUT_DIR, 'tla2tools.jar');
const URL_PIN = 'https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar';

function expected() {
  const text = readFileSync(PIN_FILE, 'utf8');
  const m = text.match(/^([0-9a-f]{64})\s+tla2tools\.jar$/m);
  if (!m) throw new Error('pin 文件里找不到 64 位 hex 行；拒绝猜一个 hash');
  return m[1];
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const want = expected();
const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  if (!existsSync(OUT)) {
    console.error(`[fetch-tlc] 未找到 ${OUT}；先跑不带 --check 的那一次`);
    process.exitCode = 2;
  } else {
    const got = sha256(readFileSync(OUT));
    console.log(`[fetch-tlc] ${got === want ? 'OK' : 'MISMATCH'}  ${got}`);
    if (got !== want) process.exitCode = 1;
  }
} else {
  console.log(`[fetch-tlc] ${URL_PIN}`);
  const res = await fetch(URL_PIN, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`[fetch-tlc] HTTP ${res.status}`);
    process.exitCode = 2;
  } else {
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== want) {
      console.error(`[fetch-tlc] sha256 不符，拒绝落盘\n  期望 ${want}\n  实得 ${got}`);
      process.exitCode = 1;
    } else {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(OUT, buf);
      console.log(`[fetch-tlc] OK  ${got}  ${buf.length} bytes → ${OUT}`);
    }
  }
}
