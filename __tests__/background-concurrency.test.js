import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import planTool from '../tools/laravel-plan.js';
import { createBackgroundManager } from '../lib/background.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

/** Fake LLM giống integration.test.js nhưng CÓ DELAY + đếm in-flight. */
const fakePlanJson = JSON.stringify({
  intent: 'feature',
  touchpoints: [
    { item: 'route', action: 'existing', file: 'routes/web.php', reason: 'đã có' },
    {
      item: 'controller',
      action: 'modify',
      file: 'app/Http/Controllers/OrderController.php',
      reason: 'gọi service',
    },
    {
      item: 'service',
      action: 'modify',
      file: 'app/Services/OrderService.php',
      reason: 'thêm approve()',
    },
    {
      item: 'view',
      action: 'modify',
      file: 'resources/views/admin/orders/detail.blade.php',
      reason: 'nút',
    },
  ],
  files: ['app/Services/OrderService.php'],
  tests: [],
  risks: [],
  assumptions: [],
  unknowns: [],
});

/**
 * Models giả có delay — đo concurrency bằng 2 thước đo KHÔNG phụ thuộc timing:
 *   1. maxInFlight: số call LLM đang chạy đồng thời (serialize ⇒ luôn = 1)
 *   2. wall-time so với baseline 1 pipeline (serialize ⇒ ≈ 3×)
 */
function delayedFakeModels(delayMs = 300) {
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    stats: {
      maxInFlight: () => maxInFlight,
      inFlight: () => inFlight,
    },
    getModel: () => ({ id: 'fake' }),
    completeSimple: async () => {
      inFlight++;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight--;
      return { content: [{ type: 'text', text: fakePlanJson }] };
    },
  };
}

function fakeBgPi() {
  const delivered = [];
  const published = [];
  return {
    pi: {
      sendUserMessage: (text, opts) => delivered.push({ text, opts }),
      publishToSession: (_sid, _ch, payload) => published.push(payload),
    },
    delivered,
    published,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDelivered(delivered, count, timeoutMs = 45000) {
  const t0 = Date.now();
  while (delivered.filter((d) => d.text.includes('PLAN')).length < count) {
    if (Date.now() - t0 > timeoutMs)
      throw new Error(`timeout: ${count} plan chưa xong sau ${timeoutMs}ms`);
    await sleep(100);
  }
}

test('CONCURRENCY: 3 background plan (3 session khác nhau) chạy SONG SONG — in-flight ≥ 5, wall < 2.5× baseline', async () => {
  // ── Baseline: 1 pipeline chạy một mình ──
  const bg1 = fakeBgPi();
  const mgr1 = createBackgroundManager(bg1.pi);
  const models1 = delayedFakeModels(300);
  const tSeq0 = Date.now();
  await planTool.execute(
    't0',
    { goal: 'thêm nút duyệt đơn' },
    undefined,
    undefined,
    {
      cwd: appRoot,
      extensionSettings: { model_planner: { provider: 'fake', modelId: 'fake' } },
      createModelsCollection: () => models1,
      background: mgr1,
      sessionManager: { getSessionId: () => 'sess-baseline' },
    },
  );
  await waitDelivered(bg1.delivered, 1);
  const tSeq = Date.now() - tSeq0;

  // ── 3 pipeline đồng thời — 3 session riêng (guard per-session không chặn) ──
  const bg = fakeBgPi();
  const mgr = createBackgroundManager(bg.pi);
  const models = delayedFakeModels(300);
  const mkCtx = (sid) => ({
    cwd: appRoot,
    extensionSettings: { model_planner: { provider: 'fake', modelId: 'fake' } },
    createModelsCollection: () => models,
    background: mgr,
    sessionManager: { getSessionId: () => sid },
  });

  const t0 = Date.now();
  const [r1, r2, r3] = await Promise.all([
    planTool.execute('t1', { goal: 'thêm nút duyệt đơn' }, undefined, undefined, mkCtx('sess-a')),
    planTool.execute('t2', { goal: 'sửa màn hình orders' }, undefined, undefined, mkCtx('sess-b')),
    planTool.execute('t3', { goal: 'thêm API export' }, undefined, undefined, mkCtx('sess-c')),
  ]);
  // Cả 3 trả về NGAY — guard theo session KHÔNG chặn session khác
  assert.equal(r1.details?.background, true, 'sess-a phải start được');
  assert.equal(r2.details?.background, true, 'sess-b phải start được');
  assert.equal(r3.details?.background, true, 'sess-c phải start được');

  await waitDelivered(bg.delivered, 3);
  const tPar = Date.now() - t0;

  const maxInFlight = models.stats.maxInFlight();

  // ── BẰNG CHỨNG SONG SONG ──
  // 1) LLM layer: nhiều call chạy đồng thời (nếu bị serialize sẽ luôn = 1)
  assert.ok(
    maxInFlight >= 5,
    `phải có lúc ≥ 5 call LLM cùng in-flight (5 planners song song), thực tế = ${maxInFlight}`,
  );
  // 2) Wall: 3 pipeline song song < 2.5× 1 pipeline (serialize sẽ ≈ 3×)
  assert.ok(
    tPar < tSeq * 2.5,
    `3 pipeline song song phải < 2.5× baseline (${tSeq}ms), thực tế = ${tPar}ms (${(tPar / tSeq).toFixed(2)}×)`,
  );
});
