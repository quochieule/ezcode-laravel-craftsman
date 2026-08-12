import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRoutesFile } from '../lib/laravel/routes-fallback.js';
import {
  aliveFromRoutes,
  findUnusedJsFunctions,
  audit,
} from '../lib/laravel/audit/dead-code.js';
import { traceFlow } from '../lib/laravel/trace-flow.js';
import { parseRouteListJson } from '../lib/laravel/routes.js';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('routes-fallback: parse web.php đơn giản', () => {
  const routes = parseRoutesFile(`
    Route::get('/admin/orders', [OrderController::class, 'index'])->name('orders.index')->middleware('auth');
    Route::post('/admin/orders/{order}/approve', [OrderController::class, 'approve'])->name('orders.approve');
    Route::resource('users', UserController::class);
  `);
  assert.ok(
    routes.some((r) => r.uri === 'admin/orders' && r.name === 'orders.index'),
  );
  assert.ok(
    routes.some((r) => r.uri.includes('approve') && r.method === 'POST'),
  );
  assert.ok(routes.some((r) => r.uri === 'users/create'));
});

test('dead-code: alive-set từ routes', async () => {
  const routes = parseRouteListJson(
    await readFile(join(here, 'fixtures', 'route-list.json'), 'utf8'),
  );
  const alive = aliveFromRoutes(routes);
  assert.ok(alive.has('OrderController@approve'));
  assert.ok(alive.size >= 4);
});

test('dead-code: JS function không ai gọi bị phát hiện', () => {
  const files = [
    {
      path: 'public/js/admin/orders.js',
      kind: 'js-file',
      functions: ['refreshOrderList', 'usedFn'],
    },
  ];
  const unused = findUnusedJsFunctions(files, [
    'function refreshOrderList() {}',
    'function usedFn() {} usedFn();',
  ]);
  assert.ok(unused.some((u) => u.name === 'refreshOrderList'));
  assert.ok(!unused.some((u) => u.name === 'usedFn'));
});

test('dead-code: audit trên contract map fixture — url broken + controller method không route', async () => {
  const routes = parseRouteListJson(
    await readFile(join(here, 'fixtures', 'route-list.json'), 'utf8'),
  );
  const { scanFrontend } =
    await import('../lib/laravel/frontend/js-extract.js');
  const { buildContractMap } =
    await import('../lib/laravel/frontend/contract-match.js');
  const { buildViewGraph, collectAllViewContent } =
    await import('../lib/laravel/frontend/blade-graph.js');

  const frontend = await scanFrontend(appRoot);
  const vg = await buildViewGraph(join(appRoot, 'resources', 'views'));
  const contractMap = buildContractMap({
    routes,
    frontend,
    domHtml: await collectAllViewContent(vg),
  });

  const controllerFiles = [
    {
      path: 'app/Http/Controllers/OrderController.php',
      content:
        'public function index() {} public function approve() {} public function orphanMethod() {}',
    },
  ];
  const result = audit({ contractMap, routes, controllerFiles });

  // url /admin/reports/export-csv không có route → broken
  assert.ok(
    result.broken.some(
      (b) => b.type === 'url' && b.what.includes('export-csv'),
    ),
  );
  // orphanMethod không route nào trỏ → possibly-dead
  assert.ok(result.possiblyDead.some((p) => p.what.includes('orphanMethod')));
  assert.ok(!result.possiblyDead.some((p) => p.what.includes('approve')));
});

test('trace-flow: trace route name end-to-end trên fixture', async () => {
  const routes = parseRouteListJson(
    await readFile(join(here, 'fixtures', 'route-list.json'), 'utf8'),
  );
  const { scanFrontend } =
    await import('../lib/laravel/frontend/js-extract.js');
  const { buildViewGraph } =
    await import('../lib/laravel/frontend/blade-graph.js');
  const frontend = await scanFrontend(appRoot);
  frontend.graphResult = await buildViewGraph(
    join(appRoot, 'resources', 'views'),
  );

  const trace = await traceFlow({
    root: appRoot,
    start: 'orders.approve',
    routes,
    frontendScan: frontend,
  });
  // route tồn tại → mắt xích đầu ok
  assert.ok(trace.chain.some((c) => c.link === 'route' && c.status === 'ok'));
  // controller@approve tồn tại trong fixture → ok
  assert.ok(
    trace.chain.some((c) => c.link === 'controller' && c.status === 'ok'),
  );
});

test('trace-flow: start không nhận diện được → broken rõ ràng', async () => {
  const routes = parseRouteListJson(
    await readFile(join(here, 'fixtures', 'route-list.json'), 'utf8'),
  );
  const trace = await traceFlow({
    root: appRoot,
    start: 'xyzzy.nothing',
    routes,
    frontendScan: { graphResult: {} },
  });
  assert.ok(trace.broken.length >= 1);
});
