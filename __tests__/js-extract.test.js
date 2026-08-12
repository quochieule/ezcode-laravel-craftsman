import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractInlineScripts,
  extractJs,
  extractFormActions,
  extractDataAttrs,
  scanFrontend,
} from '../lib/laravel/frontend/js-extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('extractInlineScripts: tách khối script trong blade', () => {
  const html = `<script>var a = 1;</script><p>x</p><script>$(function(){ });</script>`;
  const scripts = extractInlineScripts(html);
  assert.equal(scripts.length, 2);
  assert.ok(scripts[1].includes('$(function'));
});

test('extractJs: selectors — id, class, delegated, dynamic', () => {
  const r = extractJs(`
    $('#approve-order-btn').on('click', fn);
    $(document).on('click', '.quick-approve-btn', fn);
    $('#' + id + '-form').submit();
    $('.btn-primary').click();
  `);
  const sels = r.selectors;
  assert.ok(sels.some((s) => s.sel === '#approve-order-btn' && !s.delegated));
  assert.ok(sels.some((s) => s.sel === '.quick-approve-btn' && s.delegated));
  assert.ok(sels.some((s) => s.sel === '.btn-primary'));
  assert.ok(sels.some((s) => s.dynamic === true));
});

test('extractJs: urls — ajax short, url key, route(), action()', () => {
  const r = extractJs(`
    $.post('/admin/orders/' + id + '/approve');
    $.ajax({ url: '/admin/orders/export-csv', method: 'GET' });
    var u = '{{ route("orders.approve", 1) }}';
    action('App\\\\Http\\\\Controllers\\\\OrderController@approve')
  `);
  assert.ok(
    r.urls.some(
      (u) => u.url === '/admin/orders/export-csv' && u.kind === 'url-key',
    ),
  );
  assert.ok(r.urls.some((u) => u.kind === 'ajax-short' && u.dynamic));
  assert.ok(r.routeNames.includes('orders.approve'));
  assert.ok(r.urls.some((u) => u.kind === 'action'));
});

test('extractJs: global functions + CSRF setup', () => {
  const r = extractJs(`
    $.ajaxSetup({ headers: { 'X-CSRF-TOKEN': $('meta[name="csrf-token"]').attr('content') } });
    function refreshOrderList() {}
    window.deleteOrder = function (id) {};
    const loadOrders = (page) => {};
  `);
  assert.ok(r.functions.includes('refreshOrderList'));
  assert.ok(r.functions.includes('deleteOrder'));
  assert.ok(r.functions.includes('loadOrders'));
  assert.equal(r.hasCsrfSetup, true);
});

test('extractFormActions: form action + method', () => {
  const forms = extractFormActions(
    `<form action="{{ route('orders.destroy', 1) }}" method="POST" id="f">...</form>`,
  );
  assert.equal(forms.length, 1);
  assert.equal(forms[0].method, 'POST');
  assert.ok(forms[0].action.includes('orders.destroy'));
});

test('extractDataAttrs: data-url/data-id', () => {
  const attrs = extractDataAttrs(`<button data-id="42" data-url="/x">`);
  assert.equal(attrs.length, 2);
  assert.equal(attrs.find((a) => a.attr === 'id').value, '42');
});

test('scanFrontend: end-to-end trên fixture — blade inline + js file + CSRF', async () => {
  const frontend = await scanFrontend(appRoot);
  // 3 blade (1 có inline script) + 1 js file
  assert.ok(frontend.files.length >= 2);

  // inline script trong detail.blade.php: #approve-order-btn, route('orders.approve')
  const inline = frontend.files.find((f) => f.kind === 'blade-inline');
  assert.ok(inline);
  assert.ok(inline.selectors.some((s) => s.sel === '#approve-order-btn'));

  // js file: delegated selector + broken url + csrf setup
  const jsFile = frontend.files.find((f) => f.kind === 'js-file');
  assert.ok(jsFile);
  assert.ok(
    jsFile.selectors.some((s) => s.sel === '.quick-approve-btn' && s.delegated),
  );
  assert.ok(jsFile.urls.some((u) => u.url.includes('export-csv')));
  assert.equal(frontend.csrfSetup, true);
});
