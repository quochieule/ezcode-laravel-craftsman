import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  viewNameFromPath,
  parseBlade,
  buildViewGraph,
  resolveView,
  collectAllViewContent,
} from '../lib/laravel/frontend/blade-graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const viewsRoot = join(here, 'fixtures', 'laravel-app', 'resources', 'views');

test('viewNameFromPath: resources/views/admin/orders/detail.blade.php → admin.orders.detail', () => {
  const p = join(viewsRoot, 'admin', 'orders', 'detail.blade.php');
  assert.equal(viewNameFromPath(p, viewsRoot), 'admin.orders.detail');
});

test('parseBlade: bắt extends/include/component/yield/section', () => {
  const parsed = parseBlade(`
@extends('layouts.app')
@section('title', 'X')
@include('partials.order-actions', ['order' => $order])
<x-button type="submit">OK</x-button>
@push('scripts')
@stack('scripts')
@yield('content')
`);
  assert.deepEqual(parsed.extends, ['layouts.app']);
  assert.deepEqual(parsed.includes, ['partials.order-actions']);
  assert.deepEqual(parsed.xComponents, ['button']);
  assert.ok(parsed.yields.includes('content'));
  assert.ok(parsed.sections.includes('title'));
  assert.ok(parsed.pushes.includes('scripts'));
  assert.ok(parsed.stacks.includes('scripts'));
});

test('buildViewGraph: map đủ 3 view + resolveView theo dot', async () => {
  const result = await buildViewGraph(viewsRoot);
  assert.equal(Object.keys(result.map).length, 3);
  assert.ok(result.map['layouts.app']);
  assert.ok(result.map['admin.orders.detail']);
  assert.ok(result.map['partials.order-actions']);

  const resolved = resolveView('admin.orders.detail', result.map);
  assert.ok(resolved);
  assert.ok(resolved.endsWith('detail.blade.php'));
  assert.equal(resolveView('not.exists', result.map), null);
});

test('collectAllViewContent: gộp layout + partial + detail (cho DOM matching)', async () => {
  const result = await buildViewGraph(viewsRoot);
  const html = await collectAllViewContent(result);
  assert.ok(html.includes('approve-order-btn'));
  assert.ok(html.includes('delete-order-form'));
  assert.ok(html.includes('order-status'));
});
