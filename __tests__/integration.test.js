import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import planTool from '../tools/laravel-plan.js';
import { verifyClaims } from '../lib/stages/critic.js';
import { createBackgroundManager } from '../lib/background.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

/** Fake models: trả plan hợp lệ cho mọi call LLM trong pipeline. */
const fakePlanJson = JSON.stringify({
  intent: 'feature',
  touchpoints: [
    {
      item: 'route',
      action: 'existing',
      file: 'routes/web.php',
      reason: 'đã có',
    },
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
    {
      item: 'test',
      action: 'new',
      file: 'tests/Feature/OrderApproveTest.php',
      reason: 'guard',
    },
    {
      item: 'log',
      action: 'modify',
      file: 'app/Services/OrderService.php',
      reason: 'activity()',
    },
  ],
  files: [
    'app/Services/OrderService.php',
    'resources/views/admin/orders/detail.blade.php',
  ],
  tests: ['tests/Feature/OrderApproveTest.php'],
  risks: [],
  assumptions: [],
  unknowns: [],
});

function fakeModels() {
  return {
    getModel: () => ({ id: 'fake' }),
    completeSimple: async () => ({
      content: [{ type: 'text', text: fakePlanJson }],
    }),
  };
}

/** Stub pi cho background manager — capture deliver + publish. */
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

/** Poll tới khi pred() trả truthy (background pipeline chạy async). */
async function waitFor(pred, timeoutMs = 20000, stepMs = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs)
      throw new Error('timeout chờ deliver từ background pipeline');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test('INTEGRATION: laravel_plan CHẠY NỀN — execute trả về ngay, plan tới qua sendUserMessage followUp', async () => {
  const bg = fakeBgPi();
  const ctx = {
    cwd: appRoot,
    extensionSettings: { model_planner: { provider: 'fake', modelId: 'fake' } },
    createModelsCollection: fakeModels,
    background: createBackgroundManager(bg.pi),
  };
  const res = await planTool.execute(
    't1',
    { goal: 'thêm nút duyệt đơn cho admin, gửi mail cho khách' },
    undefined,
    undefined,
    ctx,
  );
  // Trả về NGAY — không chứa plan đồng bộ
  assert.equal(res.details?.background, true, 'phải là background mode');
  assert.ok(res.content[0].text.includes('chạy NỀN'), 'phải báo chạy nền');
  assert.ok(
    !res.content[0].text.includes('📋 PLAN'),
    'không được chứa plan đồng bộ',
  );

  // Plan tới qua followUp (turn mới của agent)
  const msg = await waitFor(() =>
    bg.delivered.find((d) => d.text.includes('PLAN')),
  );
  assert.equal(msg.opts?.deliverAs, 'followUp');
  const text = msg.text;
  // regression: bug cached() unwrap từng làm crash "Cannot read properties of undefined"
  assert.ok(!text.startsWith('Lỗi:'), `plan crash: ${text.slice(0, 200)}`);
  assert.ok(text.includes('PLAN'), 'phải có plan render');
  assert.ok(text.includes('score'), 'phải có critic score');
  assert.ok(
    text.includes('REQUIREMENTS'),
    'phải có requirements map từ critics',
  );
  assert.ok(text.includes('OrderService'), 'plan phải chứa touchpoint service');

  // Panel phải nhận được chuỗi event
  assert.ok(
    bg.published.some((p) => p.ev === 'task_start'),
    'phải publish task_start',
  );
  assert.ok(
    bg.published.some((p) => p.ev === 'task_update'),
    'phải publish task_update (progress)',
  );
  assert.ok(
    bg.published.some((p) => p.ev === 'task_end'),
    'phải publish task_end',
  );
});

test('INTEGRATION: use_subagents bật nhưng thiếu spawnSubagent → fallback parallel calls, plan vẫn tới', async () => {
  const bg = fakeBgPi();
  const ctx = {
    cwd: appRoot,
    extensionSettings: {
      model_planner: { provider: 'fake', modelId: 'fake' },
      use_subagents: 'true', // bật nhưng ctx KHÔNG có spawnSubagent/forkContext
    },
    createModelsCollection: fakeModels,
    background: createBackgroundManager(bg.pi),
  };
  const res = await planTool.execute(
    't-fallback',
    { goal: 'thêm nút duyệt đơn' },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(res.details?.background, true, 'vẫn chạy nền');
  const msg = await waitFor(() => bg.delivered.find((d) => d.text.includes('PLAN')));
  assert.ok(msg.text.includes('PLAN'), 'plan vẫn tới qua followUp (fallback call mode)');
});

test('INTEGRATION: laravel_plan guard — 1 task nền/session, gọi lần 2 bị chặn', async () => {
  const bg = fakeBgPi();
  const ctx = {
    cwd: appRoot,
    extensionSettings: { model_planner: { provider: 'fake', modelId: 'fake' } },
    createModelsCollection: fakeModels,
    background: createBackgroundManager(bg.pi),
    sessionManager: { getSessionId: () => 'sess-1' },
  };
  const r1 = await planTool.execute(
    't1',
    { goal: 'thêm nút duyệt đơn' },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(r1.details?.background, true);

  const r2 = await planTool.execute(
    't2',
    { goal: 'thêm nút khác' },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(
    r2.content[0].text.includes('đang chạy nền'),
    'phải báo task đang chạy',
  );
  assert.ok(!r2.content[0].text.includes('📋 PLAN'));
});

test('INTEGRATION: plan thiếu model → báo cấu hình rõ, không crash', async () => {
  const ctx = {
    cwd: appRoot,
    extensionSettings: {},
    createModelsCollection: fakeModels,
  };
  const res = await planTool.execute(
    't2',
    { goal: 'x' },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(res.content[0].text.includes('Planner model'));
});

test('INTEGRATION: repo không phải Laravel → báo rõ', async () => {
  const ctx = {
    cwd: here,
    extensionSettings: { model_planner: { provider: 'fake', modelId: 'fake' } },
    createModelsCollection: fakeModels,
  };
  const res = await planTool.execute(
    't3',
    { goal: 'x' },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(res.content[0].text.includes('không phải repo Laravel'));
});

test('REGRESSION: verifyClaims không chặn touchpoint tên generic (route/controller/service...)', async () => {
  const failed = await verifyClaims(appRoot, [
    {
      item: 'controller',
      file: 'app/Http/Controllers/OrderController.php',
      action: 'modify',
    },
    {
      item: 'service',
      file: 'app/Services/OrderService.php',
      action: 'modify',
    },
    { item: 'route', file: 'routes/web.php', action: 'existing' },
    {
      item: 'OrderController@approve',
      file: 'app/Http/Controllers/OrderController.php',
      action: 'modify',
    }, // tồn tại → pass
    {
      item: 'OrderController@ghostMethod',
      file: 'app/Http/Controllers/OrderController.php',
      action: 'modify',
    }, // không tồn tại → fail
  ]);
  assert.equal(failed.length, 1, 'chỉ claim @ không tồn tại mới bị verify');
  assert.ok(failed[0].item.includes('ghostMethod'));
});

test('TOOL: laravel_contracts chạy end-to-end trên fixture (đường fallback routes)', async () => {
  const { default: contractsTool } =
    await import('../tools/laravel-contracts.js');
  const res = await contractsTool.execute('t5', {}, undefined, undefined, {
    cwd: appRoot,
    extensionSettings: {},
  });
  const text = res.content[0].text;
  assert.ok(text.includes('🔴'), 'phải báo broken links');
  assert.ok(text.includes('export-csv'), 'phải bắt được url không có route');
  assert.ok(text.includes('CSRF'), 'phải báo CSRF status');
});

test('TOOL: laravel_audit chạy end-to-end — bắt broken + possibly-dead', async () => {
  const { default: auditTool } = await import('../tools/laravel-audit.js');
  const res = await auditTool.execute('t6', {}, undefined, undefined, {
    cwd: appRoot,
    extensionSettings: {},
  });
  const text = res.content[0].text;
  assert.ok(text.includes('BROKEN'), 'phải có mục broken');
  assert.ok(text.includes('export-csv'));
});

test('TOOL: laravel_reverify báo ✗ cho file không tồn tại + GHI learned check (learning thật)', async () => {
  const { default: reverifyTool } =
    await import('../tools/laravel-reverify.js');
  const { learnedChecks, recentEpisodes } = await import('../lib/memory.js');

  const res = await reverifyTool.execute(
    't7',
    {
      goal: 'test reverify',
      files: ['app/Models/Order.php', 'app/Models/Ghost.php'],
    },
    undefined,
    undefined,
    {
      cwd: appRoot,
      extensionSettings: {},
    },
  );
  const text = res.content[0].text;
  assert.ok(text.includes('✗'), 'phải báo mục thiếu');
  assert.ok(text.includes('Ghost'), 'thiếu = file không tồn tại');
  // không có verifier model → kênh adversarial bỏ qua sạch, không nhiễu "?"
  assert.ok(
    !text.includes('verifier fail'),
    'không được báo lỗi model như unverifiable',
  );

  // learning: mục ✗ phải thành learned check trên đĩa
  const checks = await learnedChecks(appRoot);
  assert.ok(
    checks.some((c) => c.check.includes('Ghost')),
    'learned check phải được ghi',
  );
  const eps = await recentEpisodes(appRoot, 5);
  assert.ok(
    eps.some((e) => e.intent === 'reverify'),
    'episode reverify phải được ghi',
  );
});

test('TOOL: laravel_reverify sạch khi mọi file tồn tại', async () => {
  const { default: reverifyTool } =
    await import('../tools/laravel-reverify.js');
  const res = await reverifyTool.execute(
    't8',
    { goal: 'ok', files: ['app/Models/Order.php'] },
    undefined,
    undefined,
    {
      cwd: appRoot,
      extensionSettings: {},
    },
  );
  assert.ok(res.content[0].text.includes('✓'), 'phải có mục xác minh');
  assert.ok(
    res.content[0].text.includes('✗ 0'),
    'không được có thiếu (header ✗ 0)',
  );
});
