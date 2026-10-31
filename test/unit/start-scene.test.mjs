import { TestRunner, assert, assertEquals } from '../harness.mjs';

// Base Gate 审计修订：冻结命令 `npm run start:production` 的可复现性。
// production 不得读 config 存储的 activeScene（开发机残留状态，曾致 gateway scene 残留
// 使 productionStrict 以 7 项违例拒绝启动）；未显式 --scene 时锁定 base-system。

export async function setup(runner) {
  runner.test('StartScene: production 未指定 scene 时锁定 base-system', async () => {
    const { resolveStartScene } = await import('../../src/bootstrap/cli.js');
    const scene = resolveStartScene({ profile: 'production', activeScene: 'gateway' });
    assertEquals(scene, 'base-system', 'production 应忽略开发残留的 activeScene，锁定 base-system');
  });

  runner.test('StartScene: production 显式 --scene 可覆盖', async () => {
    const { resolveStartScene } = await import('../../src/bootstrap/cli.js');
    const scene = resolveStartScene({ profile: 'production', sceneArg: 'base-system', activeScene: 'gateway' });
    assertEquals(scene, 'base-system');
  });

  runner.test('StartScene: development 沿用 activeScene，无则全量加载', async () => {
    const { resolveStartScene } = await import('../../src/bootstrap/cli.js');
    assertEquals(resolveStartScene({ profile: 'development', activeScene: 'gateway' }), 'gateway');
    assertEquals(resolveStartScene({ profile: 'development', activeScene: null }), null);
  });

  runner.test('StartScene: development 下 --scene 优先级高于 activeScene', async () => {
    const { resolveStartScene } = await import('../../src/bootstrap/cli.js');
    assertEquals(resolveStartScene({ profile: 'development', sceneArg: 'base-system', activeScene: 'gateway' }), 'base-system');
  });
}
