import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCritics } from '../lib/stages/prompt-critics.js';
import { mergePlans } from '../lib/stages/planners.js';
import {
  checkFilesExist,
  checkChecklistCoverage,
  verifyClaims,
} from '../lib/stages/critic.js';
import { deterministicChannel, renderRvpReport } from '../lib/stages/rvp.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  contractDiff,
  extractBladeFields,
  extractJsDataKeys,
  extractRequestRules,
} from '../lib/laravel/contract-diff.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('mergeCritics: union có dedup + intent theo đa số + bất đồng', () => {
  const merged = mergeCritics([
    {
      intent: 'feature',
      scope: 'both',
      explicit: ['nút duyệt', 'gửi mail'],
      ambiguous: ['duyệt nghĩa gì'],
      assumptions: ['dùng queue'],
      sessionFacts: ['đã chốt Sanctum'],
    },
    {
      intent: 'feature',
      scope: 'both',
      explicit: ['nút duyệt'],
      ambiguous: [],
      assumptions: ['dùng queue'],
      sessionFacts: ['đã chốt Sanctum'],
    },
    {
      intent: 'bugfix',
      scope: 'both',
      explicit: ['gửi mail'],
      ambiguous: ['mail cho ai'],
      assumptions: [],
      sessionFacts: [],
    },
  ]);
  assert.equal(merged.intent, 'feature'); // đa số 2/3
  assert.deepEqual(merged.explicit, ['nút duyệt', 'gửi mail']);
  assert.ok(merged.ambiguous.includes('duyệt nghĩa gì'));
  assert.ok(merged.ambiguous.includes('mail cho ai'));
  assert.equal(merged.disagreement, true); // 1 critic lệch intent
});

test('mergePlans: union touchpoints + conflict detection', () => {
  const merged = mergePlans([
    {
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
          file: 'OrderController.php',
          reason: 'x',
        },
      ],
      files: ['a.php'],
      tests: ['t1'],
      risks: ['r1'],
      assumptions: ['a1'],
      unknowns: ['u1'],
    },
    {
      touchpoints: [
        {
          item: 'route',
          action: 'new',
          file: 'routes/web.php',
          reason: 'phải thêm',
        },
        {
          item: 'view',
          action: 'modify',
          file: 'detail.blade.php',
          reason: 'y',
        },
      ],
      files: ['b.php'],
      tests: ['t2'],
      risks: ['r2'],
      assumptions: ['a1'],
      unknowns: [],
    },
  ]);
  assert.equal(merged.touchpoints.length, 3);
  const route = merged.touchpoints.find((t) => t.item === 'route');
  assert.ok(route.conflict, 'bất đồng action phải được đánh dấu');
  assert.deepEqual(route.conflict, ['existing', 'new']);
  assert.deepEqual(merged.files, ['a.php', 'b.php']);
  assert.deepEqual(merged.tests, ['t1', 't2']);
  assert.deepEqual(merged.assumptions, ['a1']);
  assert.deepEqual(merged.unknowns, ['u1']);
});

test('critic: hallucination filter + checklist coverage trên fixture', async () => {
  const missing = await checkFilesExist(appRoot, [
    'app/Models/Order.php',
    'app/Models/Ghost.php',
    'not-exist.js',
  ]);
  assert.deepEqual(missing, ['app/Models/Ghost.php', 'not-exist.js']);

  const uncovered = checkChecklistCoverage(
    [
      { item: 'route', action: 'existing' },
      { item: 'controller', action: 'modify' },
    ],
    ['route', 'controller', 'view', 'test'],
  );
  assert.deepEqual(uncovered, ['view', 'test']);
});

test('critic: claim verification — method không tồn tại bị bắt', async () => {
  const failed = await verifyClaims(appRoot, [
    {
      item: 'OrderController@approve',
      file: 'app/Http/Controllers/OrderController.php',
      action: 'modify',
    },
    {
      item: 'OrderController@ghostMethod',
      file: 'app/Http/Controllers/OrderController.php',
      action: 'modify',
    },
  ]);
  assert.equal(failed.length, 1);
  assert.ok(failed[0].item.includes('ghostMethod'));
});

test('rvp: deterministic channel — file thiếu bị bắt, render báo cáo có phần ?', async () => {
  const res = await deterministicChannel({
    root: appRoot,
    plan: {
      files: ['app/Models/Order.php', 'app/Models/Ghost.php'],
      touchpoints: [],
      tests: [],
      assumptions: [],
      unknowns: [],
    },
    checklistIds: [],
    runTests: false,
    exec: null,
  });
  assert.ok(res.missing.some((m) => m.item.includes('Ghost')));
  assert.ok(res.checked.length >= 1);

  const report = renderRvpReport({
    checked: res.checked,
    missing: res.missing,
    unverifiable: [{ what: 'php artisan test', reason: 'chưa chạy' }],
  });
  assert.ok(report.includes('✗'));
  assert.ok(report.includes('?'));
  assert.ok(report.includes('không kiểm tra được'));
});

test('contract-diff: mismatch giữa JS data, rules và blade bị bắt', () => {
  const d = contractDiff({
    bladeHtml: '<input name="order_number"><input name="total">',
    jsText: 'data: { order_number: 1, discount: 5 }',
    requestRulesText: `'order_number' => ['required'], 'total' => ['required']`,
    controllerText: `$request->input('order_number'); $request->get('ghost_field');`,
  });
  assert.ok(
    d.mismatches.some(
      (m) => m.between === 'JS→FormRequest' && m.key === 'discount',
    ),
  );
  assert.ok(
    d.mismatches.some(
      (m) => m.between === 'Controller→Blade' && m.key === 'ghost_field',
    ),
  );

  const ok = contractDiff({
    bladeHtml: '<input name="a">',
    jsText: 'data: { a: 1 }',
    requestRulesText: `'a' => ['required']`,
    controllerText: `$request->input('a')`,
  });
  assert.equal(ok.mismatches.length, 0);
});

test('extract: blade fields bỏ {{ }}, js data keys, rules', () => {
  const blade = extractBladeFields(
    '<input name="name"><input name="{{ $dynamic }}">',
  );
  assert.ok(blade.has('name'));
  assert.ok(![...blade].some((b) => b.startsWith('{{')));
  assert.deepEqual(
    [...extractJsDataKeys('data: { a: 1, "b": 2, c: 3 }')].sort(),
    ['a', 'b', 'c'],
  );
  assert.deepEqual([...extractRequestRules(`'a.b' => [], 'c' => []`)].sort(), [
    'a',
    'c',
  ]);
});
