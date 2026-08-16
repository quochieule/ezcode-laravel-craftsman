import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanSideEffects, renderSideEffects } from '../lib/laravel/side-effects.js';
import { renderViewTree, buildViewGraph } from '../lib/laravel/frontend/blade-graph.js';
import { critic } from '../lib/stages/critic.js';
import { extractGraphKeywords } from '../tools/laravel-plan.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('scanSideEffects: fixture không có Events/Jobs → rỗng, không throw', async () => {
  const se = await scanSideEffects(appRoot);
  assert.ok(Array.isArray(se.events));
  assert.ok(Array.isArray(se.jobs));
  assert.equal(se.events.length, 0);
  const text = renderSideEffects(se);
  assert.ok(text.includes('không có event/job/command/mail/notification'));
});

test('renderSideEffects: render đủ event→listener→command→mail', () => {
  const text = renderSideEffects({
    events: [{ name: 'OrderCreateEvent' }],
    listeners: [{ name: 'SendOrderData', listens: 'OrderCreateEvent' }],
    jobs: [{ name: 'ProcessRecurringTasks' }],
    commands: [{ name: 'AutomateOrderState', command: 'app:automate-order-state' }],
    mails: [{ name: 'QuotePDFMail' }],
    notifications: [],
  });
  assert.ok(text.includes('OrderCreateEvent'));
  assert.ok(text.includes('SendOrderData→OrderCreateEvent'));
  assert.ok(text.includes('app:automate-order-state'));
  assert.ok(text.includes('QuotePDFMail'));
});

test('renderViewTree: dữ liệu graph → cây extends/includes', async () => {
  const vg = await buildViewGraph(join(appRoot, 'resources', 'views'));
  const tree = renderViewTree(vg.graph, 10);
  assert.ok(typeof tree === 'string');
  // fixture có layouts/app.blade.php + admin/orders/detail.blade.php + partials
  assert.ok(tree.includes('layouts.app') || tree.includes('admin.orders.detail'));
});

test('critic: learnedChecks → advisory (không block — chống false positive)', async () => {
  const plan = {
    files: ['app/Services/OrderService.php'],
    touchpoints: [
      { item: 'controller', action: 'modify', file: 'app/Http/Controllers/OrderController.php', reason: 'x' },
    ],
    tests: ['t1'],
    assumptions: [],
    unknowns: [],
  };
  const c = await critic(
    { root: appRoot, plan, checklistIds: [], contractDiffResult: null, goal: 'x', learnedChecks: ['quên cập nhật RoutePermissionMapping'] },
    {},
  );
  assert.equal(c.blocking.length, 0, 'learned check KHÔNG được block');
  const learned = c.advisory.find((a) => a.check === 'learned');
  assert.ok(learned, 'phải có advisory learned');
  assert.ok(learned.detail.includes('RoutePermissionMapping'));
  assert.ok(c.report.includes('RoutePermissionMapping'), 'report phải nhắc lỗi lịch sử');
});

test('extractGraphKeywords: lấy symbol-like từ goal, bỏ stopwords', () => {
  const kws = extractGraphKeywords('thêm nút duyệt đơn cho admin, gửi mail cho khách, sửa OrderController@approve');
  assert.ok(kws.some((k) => k.includes('OrderController')), 'phải lấy OrderController');
  assert.ok(kws.every((k) => !['thêm', 'nút', 'mail', 'admin'].includes(k.toLowerCase())), 'phải bỏ stopwords');
});
