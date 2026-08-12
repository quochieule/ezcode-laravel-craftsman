import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRouteListJson } from '../lib/laravel/routes.js';
import { scanFrontend } from '../lib/laravel/frontend/js-extract.js';
import {
  buildViewGraph,
  collectAllViewContent,
} from '../lib/laravel/frontend/blade-graph.js';
import {
  matchSelector,
  extractDomTokens,
  buildContractMap,
  renderContractMap,
} from '../lib/laravel/frontend/contract-match.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('extractDomTokens: id + class từ HTML', () => {
  const dom = extractDomTokens(
    '<div id="app"><span class="btn btn-primary" id="x"></span></div>',
  );
  assert.ok(dom.ids.has('app'));
  assert.ok(dom.ids.has('x'));
  assert.ok(dom.classes.has('btn'));
  assert.ok(dom.classes.has('btn-primary'));
});

test('matchSelector: found / missing / dynamic / delegated', () => {
  const dom = extractDomTokens(
    '<div id="order-card" class="card"><span id="order-status"></span></div>',
  );
  assert.equal(
    matchSelector({ sel: '#order-card', delegated: false, dynamic: false }, dom)
      .status,
    'found',
  );
  assert.equal(
    matchSelector({ sel: '#ghost', delegated: false, dynamic: false }, dom)
      .status,
    'missing',
  );
  assert.equal(
    matchSelector({ sel: '.card', delegated: false, dynamic: false }, dom)
      .status,
    'found',
  );
  assert.equal(
    matchSelector({ sel: '#a .nope', delegated: false, dynamic: false }, dom)
      .status,
    'missing',
  );
  assert.equal(
    matchSelector({ sel: '#' + 'x', delegated: false, dynamic: true }, dom)
      .status,
    'dynamic',
  );
  // selector không có token #/. → unparseable (vd thẻ)
  assert.equal(
    matchSelector({ sel: 'button', delegated: false, dynamic: false }, dom)
      .status,
    'unparseable',
  );
});

test('buildContractMap: end-to-end — broken URL bị bắt, route() resolve, selector khớp', async () => {
  const routes = parseRouteListJson(
    await readFile(join(here, 'fixtures', 'route-list.json'), 'utf8'),
  );
  const frontend = await scanFrontend(appRoot);
  const viewGraph = await buildViewGraph(join(appRoot, 'resources', 'views'));
  const domHtml = await collectAllViewContent(viewGraph);

  const map = buildContractMap({ routes, frontend, domHtml });

  // route('orders.approve') trong inline blade → resolve bằng tên
  assert.ok(
    map.urls.some(
      (u) =>
        u.kind === 'route-name' && u.match?.route?.name === 'orders.approve',
    ),
  );

  // POST /admin/orders/' + id + '/approve (ghép chuỗi) → dynamic, KHÔNG bị coi là khớp/broken
  const dynamicUrl = map.urls.find((u) => u.kind === 'ajax-short' && u.dynamic);
  assert.ok(dynamicUrl, 'URL ghép chuỗi phải được đánh dấu dynamic');
  assert.equal(dynamicUrl.match, null);

  // 🔴 export-csv — không có route
  const broken = map.urls.filter(
    (u) => !u.match && u.kind !== 'route-name' && !u.dynamic,
  );
  assert.ok(broken.some((u) => u.url.includes('reports/export-csv')));

  // selector #approve-order-btn có trong partial (qua view graph)
  assert.ok(
    map.selectors.some(
      (s) => s.sel === '#approve-order-btn' && s.status === 'found',
    ),
  );

  // form action route('orders.destroy') → form-action khớp
  assert.ok(
    map.urls.some(
      (u) =>
        u.kind === 'form-action' && u.match?.route?.name === 'orders.destroy',
    ),
  );

  // summary phản ánh đúng
  assert.ok(map.summary.urls.broken >= 1);
  assert.ok(map.summary.selectors.found >= 1);
  assert.equal(map.csrfSetup, true);

  // render không throw và có đánh dấu 🔴
  const rendered = renderContractMap(map);
  assert.ok(rendered.includes('🔴'));
  assert.ok(rendered.includes('CSRF'));
});
