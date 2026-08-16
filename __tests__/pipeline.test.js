import { test } from 'node:test';
import assert from 'node:assert/strict';
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
