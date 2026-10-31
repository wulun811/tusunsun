import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_DIR = '/tmp/tusunsun-drain-test';
let passed = 0, total = 0, failed = [];

function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log(`  OK ${msg}`); }
  else { failed.push(msg); console.log(`  FAIL ${msg}`); }
}

async function run() {
  if (existsSync(TEST_DIR)) await rm(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  const stateDir = join(TEST_DIR, 'state');
  mkdirSync(stateDir, { recursive: true });

  const { Core } = await import('../src/core/core.js');
  const { LifecycleManager } = await import('../src/core/lifecycle-manager.js');

  // ========== TEST 1: No inflight → drain returns immediately ==========
  console.log('\nTEST 1: No inflight → drain returns fast');

  const core1 = new Core({ stateDir: join(stateDir, 'fast') });
  core1.registerCapability('test.work', { handler: async () => 'done', owner: 'worker' });
  const lcm1 = new LifecycleManager(core1);

  assert(core1.getInflight('worker') === 0, 'inflight starts at 0');

  const t0 = Date.now();
  await lcm1._step3DrainRequests('worker', 5000);
  const elapsed = Date.now() - t0;
  assert(elapsed < 200, `no inflight → fast drain (${elapsed}ms, expected <200ms)`);

  // ========== TEST 2: Inflight → drain waits ==========
  console.log('\nTEST 2: Inflight present → drain waits for completion');

  const core2 = new Core({ stateDir: join(stateDir, 'wait') });
  let resolveSlow;
  core2.registerCapability('slow.op', {
    handler: () => new Promise(r => { resolveSlow = r; }),
    owner: 'worker2',
  });
  const lcm2 = new LifecycleManager(core2);

  assert(core2.getInflight('worker2') === 0, 'inflight starts at 0');

  // Start a slow call (won't await it)
  const callPromise = core2.callCapability('slow.op', {});

  // Give it a moment to register inflight
  await new Promise(r => setTimeout(r, 50));
  assert(core2.getInflight('worker2') === 1, 'inflight = 1 during call');

  const t2 = Date.now();
  const drainPromise = lcm2._step3DrainRequests('worker2', 5000);
  await new Promise(r => setTimeout(r, 300));
  // Resolve the pending call
  resolveSlow('ok');
  await drainPromise;
  const elapsed2 = Date.now() - t2;
  assert(core2.getInflight('worker2') === 0, 'inflight back to 0 after drain');
  assert(elapsed2 >= 300 && elapsed2 < 1000, `drain waited for completion (${elapsed2}ms)`);

  // ========== TEST 3: Inflight timeout (call hangs, drain returns after timeout) ==========
  console.log('\nTEST 3: Hung inflight → drain times out');

  const core3 = new Core({ stateDir: join(stateDir, 'hung') });
  core3.registerCapability('hung.op', {
    handler: () => new Promise(() => {}), // never resolves
    owner: 'worker3',
  });
  const lcm3 = new LifecycleManager(core3);

  core3.callCapability('hung.op', {}).catch(() => {});
  await new Promise(r => setTimeout(r, 50));
  assert(core3.getInflight('worker3') === 1, 'inflight = 1 for hung call');

  const t3 = Date.now();
  await lcm3._step3DrainRequests('worker3', 1000);
  const elapsed3 = Date.now() - t3;
  assert(elapsed3 >= 900 && elapsed3 < 1200, `hung drain timed out (${elapsed3}ms, expected ~1000ms)`);

  // ========== TEST 4: Multiple concurrent inflight ==========
  console.log('\nTEST 4: Multiple concurrent inflight drain');

  const core4 = new Core({ stateDir: join(stateDir, 'multi') });
  let pending = [];
  core4.registerCapability('multi.op', {
    handler: () => new Promise((resolve) => { pending.push(resolve); }),
    owner: 'multi-worker',
  });

  // Fire 3 concurrent calls
  core4.callCapability('multi.op', {}).catch(() => {});
  core4.callCapability('multi.op', {}).catch(() => {});
  core4.callCapability('multi.op', {}).catch(() => {});

  await new Promise(r => setTimeout(r, 50));
  assert(core4.getInflight('multi-worker') === 3, 'inflight = 3 for 3 concurrent calls');

  // Resolve all after 200ms
  setTimeout(() => { for (const r of pending) r('ok'); }, 200);

  const lcm4 = new LifecycleManager(core4);
  const t4 = Date.now();
  await lcm4._step3DrainRequests('multi-worker', 5000);
  const elapsed4 = Date.now() - t4;
  assert(core4.getInflight('multi-worker') === 0, 'inflight back to 0');
  assert(elapsed4 < 500, `multi drain fast (${elapsed4}ms)`);

  // ========== SUMMARY ==========
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passed: ${passed}/${total}`);
  if (failed.length) {
    console.log(`Failed: ${failed.length}`);
    for (const f of failed) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('All tests passed!');
  await rm(TEST_DIR, { recursive: true });
}

run().catch(err => { console.error(err); process.exit(1); });
