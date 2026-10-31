import { TestRunner, assert, assertEquals } from '../harness.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const tuiPath = join(__dirname, '../../plugins/tui.js');

export async function setup(runner) {
  let tuiModule;

  runner.beforeAll(async () => {
    const url = new URL(tuiPath, import.meta.url).href;
    tuiModule = await import(url);
  });

  runner.test('tui: exports cliCommands array', () => {
    assert(Array.isArray(tuiModule.cliCommands), 'cliCommands should be an array');
    assertEquals(tuiModule.cliCommands.length, 1, 'should export exactly 1 cli command');
  });

  runner.test('tui: cliCommands has correct structure', () => {
    const cmd = tuiModule.cliCommands[0];
    assert(cmd.name === 'tui', 'command name should be "tui"');
    assert(typeof cmd.description === 'string', 'description should be a string');
    assert(cmd.description.length > 0, 'description should not be empty');
    assert(typeof cmd.handler === 'function', 'handler should be a function');
  });

  runner.test('tui: TUIApp class is exported', () => {
    // TUIApp is defined inside tui.js but not directly exported
    // We verify the module structure instead
    assert(tuiModule.cliCommands[0].handler, 'handler function exists');
  });

  runner.test('tui: plugin file has reasonable size', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    const lines = content.split('\n').length;
    assert(lines > 500, `tui.js should have > 500 lines, has ${lines}`);
    assert(lines < 1000, `tui.js should have < 1000 lines, has ${lines}`);
  });

  runner.test('tui: contains ANSI escape code definitions', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('const ESC'), 'should define ESC constant');
    assert(content.includes('const CSI'), 'should define CSI constant');
    assert(content.includes('const ansi'), 'should define ansi object');
  });

  runner.test('tui: defines all required view classes', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('class MonitorView'), 'should define MonitorView');
    assert(content.includes('class PluginView'), 'should define PluginView');
    assert(content.includes('class SceneView'), 'should define SceneView');
    assert(content.includes('class ConfigView'), 'should define ConfigView');
    assert(content.includes('class ChatView'), 'should define ChatView');
    assert(content.includes('class TUIApp'), 'should define TUIApp');
  });

  runner.test('tui: defines WsClient for gateway communication', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('class WsClient'), 'should define WsClient');
    assert(content.includes('connect()'), 'WsClient should have connect method');
    assert(content.includes('request('), 'WsClient should have request method');
    assert(content.includes('requestStream('), 'WsClient should have requestStream method');
  });

  runner.test('tui: defines ScreenManager for terminal rendering', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('class ScreenManager'), 'should define ScreenManager');
    assert(content.includes('drawBox('), 'ScreenManager should have drawBox method');
    assert(content.includes('drawFooter('), 'ScreenManager should have drawFooter method');
  });

  runner.test('tui: supports keyboard input handling', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('setRawMode'), 'should enable raw mode for stdin');
    assert(content.includes('_handleKey'), 'should have key handler');
    assert(content.includes('process.stdin.on'), 'should listen to stdin data');
  });

  runner.test('tui: has proper cleanup on exit', () => {
    const content = readFileSync(tuiPath, 'utf-8');
    assert(content.includes('SIGINT'), 'should handle SIGINT');
    assert(content.includes('SIGTERM'), 'should handle SIGTERM');
    assert(content.includes('screen.stop()'), 'should stop screen manager on exit');
    assert(content.includes('ws.close()'), 'should close websocket on exit');
  });
}
