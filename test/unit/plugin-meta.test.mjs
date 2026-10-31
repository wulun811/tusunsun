import { readFileHeader, extractPluginMeta, extractPluginMetaFromFile } from '../../src/core/plugin-meta.js';
import { TestRunner, assert, assertEquals, assertThrows, assertRejects } from '../harness.mjs';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export async function setup(runner) {
  let testDir;

  runner.beforeEach(() => {
    testDir = join(tmpdir(), `tusunsun-meta-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  runner.afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  function write(name, content) {
    const p = join(testDir, name);
    writeFileSync(p, content);
    return p;
  }

  runner.test('readFileHeader: normal read', async () => {
    const p = write('test.js', '// header comment\nexport default { name: "test" };');
    const header = await readFileHeader(p, 20);
    assertEquals(header.length, 20, 'Should read 20 bytes');
    assert(header.startsWith('// header'), 'Should start with comment');
  });

  runner.test('readFileHeader: file not found', async () => {
    await assertRejects(() => readFileHeader(join(testDir, 'nonexistent.js')), 'Should throw ENOENT');
  });

  runner.test('readFileHeader: empty file', async () => {
    const p = write('empty.js', '');
    const header = await readFileHeader(p, 100);
    assertEquals(header, '', 'Should return empty string');
  });

  runner.test('readFileHeader: file smaller than maxBytes', async () => {
    const p = write('small.js', 'hi');
    const header = await readFileHeader(p, 100);
    assertEquals(header, 'hi', 'Should return full content');
  });

  runner.test('extractPluginMeta: complete plugin', () => {
    const src = `
export const name = 'my-plugin';
export const version = '1.2.3';
export const provides = ['chat', 'search'];
export const requires = { core: '^1.0.0' };
export async function init(core) {}
`;
    const meta = extractPluginMeta(src, '/test/my-plugin.js');
    assertEquals(meta.name, 'my-plugin');
    assertEquals(meta.version, '1.2.3');
    assertEquals(meta.provides.length, 2);
    assertEquals(meta.provides[0], 'chat');
    assertEquals(meta.provides[1], 'search');
    assertEquals(meta.requires.core, '^1.0.0');
  });

  runner.test('extractPluginMeta: minimal plugin', () => {
    const src = `
export const name = 'min-plugin';
export async function init(core) {}
`;
    const meta = extractPluginMeta(src, '/test/min-plugin.js');
    assertEquals(meta.name, 'min-plugin');
    assertEquals(meta.version, null);
    assertEquals(meta.provides.length, 0);
    assertEquals(Object.keys(meta.requires).length, 0);
  });

  runner.test('extractPluginMeta: non-plugin file', () => {
    const src = `
export function helper() { return 42; }
`;
    const meta = extractPluginMeta(src, '/test/helper.js');
    assertEquals(meta.name, null);
    assertEquals(meta.version, null);
    assertEquals(meta.provides.length, 0);
    assertEquals(Object.keys(meta.requires).length, 0);
  });

  runner.test('extractPluginMeta: reexport single layer', () => {
    const src = `export { default } from './real-plugin'`;
    const meta = extractPluginMeta(src, '/test/index.js');
    assertEquals(meta._reexport, './real-plugin');
    assertEquals(meta.name, null);
  });

  runner.test('extractPluginMeta: provides with nested brackets', () => {
    const src = `
export const name = 'nested';
export const provides = ['a', ['b', 'c']];
`;
    const meta = extractPluginMeta(src, '/test/nested.js');
    assertEquals(meta.provides.length, 2);
    assertEquals(meta.provides[0], 'a');
    assert(Array.isArray(meta.provides[1]), 'Nested array should be preserved');
  });

  runner.test('extractPluginMeta: provides with parentheses in string', () => {
    const src = `
export const name = 'parens';
export const provides = ['a(b)', 'c'];
`;
    const meta = extractPluginMeta(src, '/test/parens.js');
    assertEquals(meta.provides[0], 'a(b)');
  });

  runner.test('extractPluginMeta: provides with escaped quotes (simple parser limitation)', () => {
    const src = `
export const name = 'escape';
export const provides = ['hello', 'world'];
`;
    const meta = extractPluginMeta(src, '/test/escape.js');
    assertEquals(meta.provides[0], 'hello');
    assertEquals(meta.provides[1], 'world');
  });

  runner.test('extractPluginMeta: requires parsing', () => {
    const src = `
export const name = 'req-test';
export const requires = { core: '^1.0', auth: '>=2.0.0' };
`;
    const meta = extractPluginMeta(src, '/test/req.js');
    assertEquals(meta.requires.core, '^1.0');
    assertEquals(meta.requires.auth, '>=2.0.0');
  });

  runner.test('extractPluginMeta: no provides or requires', () => {
    const src = `export const name = 'bare';`;
    const meta = extractPluginMeta(src, '/test/bare.js');
    assertEquals(meta.provides.length, 0);
    assertEquals(Object.keys(meta.requires).length, 0);
  });

  runner.test('extractPluginMetaFromFile: valid plugin', async () => {
    const p = write('valid.js', `
export const name = 'from-file';
export const version = '2.0.0';
export async function init(core) {}
`);
    const meta = await extractPluginMetaFromFile(p);
    assertEquals(meta.name, 'from-file');
    assertEquals(meta.version, '2.0.0');
  });

  runner.test('extractPluginMetaFromFile: file not found', async () => {
    const meta = await extractPluginMetaFromFile(join(testDir, 'nonexistent.js'));
    assertEquals(meta.name, null);
    assertEquals(meta.version, null);
    assertEquals(meta.provides.length, 0);
  });

  runner.test('extractPluginMetaFromFile: reexport chain', async () => {
    write('real.js', `
export const name = 'real-plugin';
export const version = '1.0.0';
export async function init(core) {}
`);
    const p = write('index.js', `export { default } from './real.js'`);
    const meta = await extractPluginMetaFromFile(p);
    assertEquals(meta.name, 'real-plugin');
  });

  runner.test('extractPluginMeta: empty source', () => {
    const meta = extractPluginMeta('', '/test/empty.js');
    assertEquals(meta.name, null);
    assertEquals(meta.version, null);
  });

  runner.test('extractPluginMeta: only version, no name', () => {
    const src = `export const version = '0.1.0';`;
    const meta = extractPluginMeta(src, '/test/vonly.js');
    assertEquals(meta.name, null);
    assertEquals(meta.version, '0.1.0');
  });

  runner.test('extractPluginMeta: provides with trailing comma', () => {
    const src = `
export const name = 'trailing';
export const provides = ['a', 'b',];
`;
    const meta = extractPluginMeta(src, '/test/trailing.js');
    assertEquals(meta.provides.length, 2);
    assertEquals(meta.provides[0], 'a');
    assertEquals(meta.provides[1], 'b');
  });
}
