/**
 * Contract match — nối 2 thế giới: frontend (chuỗi) ↔ backend (route/DOM).
 *
 *   1. url/route('name') từ JS/HTML → route inventory (exact / param / prefix)
 *   2. jQuery selector → DOM trong toàn bộ views (layout + partials + AJAX partials)
 *
 * Output có confidence, không bao giờ khẳng định tuyệt đối khi không chắc —
 * đúng tinh thần "grounded, không suy đoán vô căn cứ".
 */
import { matchUrlToRoute, findRouteByName } from '../routes.js';

/** Trích id= / class= từ 1 chuỗi HTML. */
export function extractDomTokens(html) {
  const ids = new Set();
  const classes = new Set();
  const add = (set, raw) => {
    const v = String(raw).trim();
    if (!v) return;
    // blade động: id="orders{{ $order->id }}" → đăng ký cả phần prefix tĩnh "orders"
    const m = v.match(/^([^\s{{]+)/);
    if (m) set.add(m[1]);
    if (!v.includes('{{')) set.add(v);
  };
  let m;
  const idRe = /\bid\s*=\s*["']([^"']+)["']/g;
  while ((m = idRe.exec(html))) add(ids, m[1]);
  const classRe = /\bclass\s*=\s*["']([^"']+)["']/g;
  while ((m = classRe.exec(html))) {
    for (const c of m[1].split(/\s+/)) add(classes, c);
  }
  return { ids, classes };
}

/**
 * Kiểm tra 1 selector jQuery có tồn tại trong DOM (toàn bộ views).
 * Selector động (có '+', '${', '{{') → không match tĩnh được → { status: 'dynamic' }.
 * Selector đơn giản: tách token #id/.class — mọi token phải có mặt.
 * @param {{sel:string, delegated:boolean, dynamic:boolean}} item
 * @param {{ids:Set, classes:Set}} dom
 */
export function matchSelector(item, dom) {
  if (item.dynamic) return { ...item, status: 'dynamic' };
  const tokens = item.sel.match(/#[A-Za-z_][\w-]*|\.-?[A-Za-z_][\w-]*/g) || [];
  if (tokens.length === 0) return { ...item, status: 'unparseable' };
  const missing = tokens.filter((t) => {
    if (t.startsWith('#')) return !dom.ids.has(t.slice(1));
    return !dom.classes.has(t.slice(1));
  });
  if (missing.length === 0) return { ...item, status: 'found' };
  return { ...item, status: 'missing', missingTokens: missing };
}

/**
 * Build bản đồ contract đầy đủ.
 * @param {object} input { routes:Array, frontend:object (scanFrontend), domHtml:string }
 * @returns {{urls:Array, selectors:Array, summary:object}}
 */
export function buildContractMap({ routes, frontend, domHtml }) {
  const dom = extractDomTokens(domHtml || '');

  // ── URLs → routes ──
  const urls = [];
  for (const u of frontend.allUrls || []) {
    // URL không phải HTTP/route (javascript:, #, mailto:, tel:) — không phải contract
    const scheme = String(u.url).trim().toLowerCase();
    if (/^(javascript:|#|mailto:|tel:|data:)/.test(scheme)) {
      urls.push({ ...u, match: null, status: 'not-http' });
      continue;
    }
    if (u.kind === 'action') {
      const route = routes.find(
        (r) => r.action === u.url.replace(/^action:/, ''),
      );
      urls.push({
        ...u,
        match: route ? { route, confidence: 1.0, reason: 'action' } : null,
        status: route ? 'matched' : 'broken',
      });
      continue;
    }
    // URL chứa route('name') (form action / blade inline) → resolve theo tên
    const named = /route\s*\(\s*['"]([^'"]+)['"]/.exec(u.url);
    if (named) {
      const route = findRouteByName(named[1], routes);
      urls.push({
        ...u,
        match: route ? { route, confidence: 1.0, reason: 'named' } : null,
        status: route ? 'matched' : 'broken',
      });
      continue;
    }
    // URL ghép chuỗi → không match tĩnh được, đánh dấu dynamic (không tính broken)
    if (u.dynamic) {
      urls.push({ ...u, match: null, status: 'dynamic' });
      continue;
    }
    const match = matchUrlToRoute(u.url, routes);
    urls.push({ ...u, match, status: match ? 'matched' : 'broken' });
  }
  // route('name') trong JS inline — 🟡 chưa resolve KHÔNG tính 🔴 broken (tách riêng)
  for (const name of frontend.allRouteNames || []) {
    const route = findRouteByName(name, routes);
    urls.push({
      url: `route('${name}')`,
      kind: 'route-name',
      dynamic: false,
      match: route ? { route, confidence: 1.0, reason: 'named' } : null,
      status: route ? 'matched' : 'unknown-named',
    });
  }

  // ── Selectors → DOM ──
  const selectors = (frontend.allSelectors || []).map((s) =>
    matchSelector(s, dom),
  );

  // ── Summary ──
  const urlMatched = urls.filter((u) => u.status === 'matched').length;
  const urlBroken = urls.filter((u) => u.status === 'broken').length;
  const urlDynamic = urls.filter((u) => u.status === 'dynamic').length;
  const urlNotHttp = urls.filter((u) => u.status === 'not-http').length;
  const urlUnknownNamed = urls.filter(
    (u) => !u.match && u.kind === 'route-name',
  ).length;
  const selFound = selectors.filter((s) => s.status === 'found').length;
  const selDelegated = selectors.filter((s) => s.status === 'delegated').length;
  const selMissing = selectors.filter((s) => s.status === 'missing').length;
  const selDynamic = selectors.filter((s) => s.status === 'dynamic').length;

  return {
    urls,
    selectors,
    csrfSetup: frontend.csrfSetup,
    views: frontend.views || [],
    summary: {
      urls: {
        total: urls.length,
        matched: urlMatched,
        broken: urlBroken,
        dynamic: urlDynamic,
        notHttp: urlNotHttp,
        unknownNamed: urlUnknownNamed,
      },
      selectors: {
        total: selectors.length,
        found: selFound,
        delegated: selDelegated,
        missing: selMissing,
        dynamic: selDynamic,
      },
    },
  };
}

/** Render bản đồ contract gọn cho agent (báo signal, không tràn). */
export function renderContractMap(map) {
  const s = map.summary;
  const lines = [
    `URLs: ${s.urls.matched}/${s.urls.total} khớp route` +
      (s.urls.broken ? ` · 🔴 ${s.urls.broken} KHÔNG khớp` : '') +
      (s.urls.dynamic
        ? ` · ${s.urls.dynamic} dynamic (ghép chuỗi — cần đọc code để xác minh)`
        : '') +
      (s.urls.unknownNamed
        ? ` · ${s.urls.unknownNamed} route() chưa resolve`
        : ''),
    `Selectors: ${s.selectors.found} found · ${s.selectors.delegated} delegated · ${s.selectors.dynamic} dynamic` +
      (s.selectors.missing ? ` · 🔴 ${s.selectors.missing} MISSING` : ''),
    `CSRF setup trong JS: ${map.csrfSetup ? '✓' : '✗ (kiểm tra $.ajaxSetup / meta csrf-token)'}`,
  ];

  const brokenUrls = map.urls.filter((u) => u.status === 'broken').slice(0, 15);
  if (brokenUrls.length) {
    lines.push('🔴 URL không khớp route nào:');
    for (const u of brokenUrls) lines.push(`  - ${u.url} (${u.kind})`);
  }
  const missingSels = map.selectors
    .filter((s) => s.status === 'missing')
    .slice(0, 15);
  if (missingSels.length) {
    lines.push('🔴 Selector không có trong views:');
    for (const s of missingSels)
      lines.push(
        `  - ${s.sel}${s.missingTokens ? ` (thiếu: ${s.missingTokens.join(', ')})` : ''}`,
      );
  }
  const namedMissing = map.urls
    .filter((u) => u.kind === 'route-name' && !u.match)
    .slice(0, 10);
  if (namedMissing.length) {
    lines.push('🟡 route() chưa resolve (route:list không có tên này):');
    for (const u of namedMissing) lines.push(`  - ${u.url}`);
  }
  return lines.join('\n');
}
