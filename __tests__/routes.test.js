import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseRouteListJson,
  normalizeUri,
  matchUrlToRoute,
  findRouteByName,
} from '../lib/laravel/routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureJson = await readFile(
  join(here, 'fixtures', 'route-list.json'),
  'utf8',
);

test('parseRouteListJson: parse đúng output artisan', () => {
  const routes = parseRouteListJson(fixtureJson);
  assert.equal(routes.length, 4);
  const approve = routes.find((r) => r.name === 'orders.approve');
  assert.equal(approve.method, 'POST');
  assert.equal(approve.uri, 'admin/orders/{order}/approve');
  assert.ok(approve.middleware.includes('role:admin'));
  assert.ok(approve.action.includes('OrderController@approve'));
});

test('parseRouteListJson: JSON hỏng → [] (không throw)', () => {
  assert.deepEqual(parseRouteListJson('not json'), []);
  assert.deepEqual(parseRouteListJson(''), []);
});

test('normalizeUri: làm sạch scheme/host/query/trailing slash/{{ }}', () => {
  assert.equal(
    normalizeUri('http://localhost:8000/admin/orders/'),
    'admin/orders',
  );
  assert.equal(normalizeUri('/admin/orders?page=2#top'), 'admin/orders');
  assert.equal(
    normalizeUri("{{ route('orders.index') }}"),
    'route(orders.index)',
  );
  assert.equal(normalizeUri('/public/admin/orders'), 'admin/orders');
});

test('matchUrlToRoute: khớp chính xác (confidence 1.0)', () => {
  const routes = parseRouteListJson(fixtureJson);
  const m = matchUrlToRoute('/admin/orders/12/approve', routes);
  assert.ok(m);
  assert.equal(m.route.name, 'orders.approve');
  assert.equal(m.confidence, 1.0);
  assert.equal(m.reason, 'exact');
});

test('matchUrlToRoute: prefix match (url dài hơn route uri, confidence 0.75)', () => {
  const routes = parseRouteListJson(fixtureJson);
  const m = matchUrlToRoute('/admin/orders/12/edit', routes);
  assert.ok(m);
  assert.equal(m.route.name, 'orders.show'); // {order} khớp segment
  assert.equal(m.confidence, 0.75);
  assert.equal(m.reason, 'prefix');
});

test('matchUrlToRoute: URL không có route → null', () => {
  const routes = parseRouteListJson(fixtureJson);
  assert.equal(matchUrlToRoute('/admin/reports/export-csv', routes), null);
  assert.equal(matchUrlToRoute('', routes), null);
  assert.equal(matchUrlToRoute('/admin/orders/12/approve', []), null);
});

test('findRouteByName: tìm theo tên route()', () => {
  const routes = parseRouteListJson(fixtureJson);
  const r = findRouteByName('orders.approve', routes);
  assert.ok(r);
  assert.equal(r.uri, 'admin/orders/{order}/approve');
  assert.equal(findRouteByName('not.exist', routes), null);
});
