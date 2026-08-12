/**
 * Route inventory — ground truth từ `php artisan route:list --json`.
 *
 * Đây là nguồn sự thật cho mọi thứ liên quan route: agent không bao giờ phải
 * đoán route có tồn tại hay không, controller@method trỏ tới đâu.
 *
 * Tách 2 lớp:
 *   - `parseRouteListJson` — pure, test được (nhận JSON artisan, trả mảng route)
 *   - `loadRoutes` — chạy artisan thật trong cwd
 */
import { runArtisan } from '../exec.js';

/**
 * Parse output `php artisan route:list --json` (Laravel 8+).
 * @param {string} json
 * @returns {Array<{method:string, uri:string, name:string|null, action:string, middleware:string[], domain:string|null}>}
 */
export function parseRouteListJson(json) {
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data.routes || [];
  return rows
    .map((r) => ({
      method: String(r.method || r.methods || '').toUpperCase(),
      uri: String(r.uri || r.uriPath || '').replace(/^\//, ''),
      name: r.name || r.routeName || null,
      action: r.action || r.controller || '',
      middleware: Array.isArray(r.middleware)
        ? r.middleware
        : String(r.middleware || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
      domain: r.domain || null,
    }))
    .filter((r) => r.uri);
}

/** Đọc route inventory từ repo Laravel thật. */
export async function loadRoutes(cwd, opts = {}) {
  const stdout = await runArtisan(cwd, ['route:list', '--json'], opts);
  return parseRouteListJson(stdout);
}

/**
 * loadRoutes an toàn: artisan fail HOẶC trả 0 route (exit 0 nhưng output rỗng/
 * không phải app thật) → fallback parse routes/web.php + api.php.
 */
export async function loadRoutesSafe(cwd, opts = {}) {
  try {
    const parsed = await loadRoutes(cwd, opts);
    if (parsed.length) return parsed;
  } catch {
    /* artisan fail → fallback */
  }
  const { loadRoutesFallback } = await import('./routes-fallback.js');
  return loadRoutesFallback(cwd);
}

/** Làm sạch URI/URL để so khớp: bỏ scheme/host/query/trailing slash, lowercase. */
export function normalizeUri(s) {
  if (!s) return '';
  let u = String(s).trim();
  // bỏ {{ }} (blade) + dấu nháy — GIỮ {param} của route
  u = u.replace(/\{\{|\}\}|["'`]/g, '');

  // bỏ scheme + host (http://example.com)
  u = u.replace(/^https?:\/\/[^/]+/i, '');
  // bỏ query/hash
  u = u.split(/[?#]/)[0];
  // bỏ base path thường gặp của Laravel local (/public, /index.php)
  u = u.replace(/^\/(?:index\.php|public)(?=\/|$)/, '');
  u = u.replace(/^\/+(?!$)/, '').replace(/\/+$/, '');
  return u.trim().toLowerCase();
}

/** Tách uri thành segments. */
function segments(uri) {
  return normalizeUri(uri).split('/').filter(Boolean);
}

/** Kiểm tra 1 segment route có phải placeholder {param} / {param?} không. */
function isParam(seg) {
  return /^\{[^}]+\}.*$/.test(seg);
}

/**
 * So khớp 1 URL (từ JS/HTML) với route inventory.
 * @param {string} url  URL thô (có thể có scheme, query, id cứng...)
 * @param {Array} routes  từ parseRouteListJson
 * @returns {{route: object|null, confidence: number, reason: string}|null}
 */
export function matchUrlToRoute(url, routes) {
  if (!url || !Array.isArray(routes) || routes.length === 0) return null;
  const urlSegs = segments(url);
  if (urlSegs.length === 0) return null;

  let best = null;
  let bestSegs = 0;
  for (const r of routes) {
    const rSegs = segments(r.uri);
    if (rSegs.length === 0) continue;

    // Khớp chính xác từng segment (route param khớp mọi giá trị)
    let exact = true;
    if (urlSegs.length === rSegs.length) {
      for (let i = 0; i < rSegs.length; i++) {
        if (isParam(rSegs[i])) continue;
        if (rSegs[i] !== urlSegs[i]) {
          exact = false;
          break;
        }
      }
    } else {
      exact = false;
    }

    // Prefix: url là phần mở rộng của route uri (vd route /orders, url /orders/12/edit)
    let prefix = false;
    if (!exact && urlSegs.length > rSegs.length) {
      prefix = true;
      for (let i = 0; i < rSegs.length; i++) {
        if (isParam(rSegs[i])) continue;
        if (rSegs[i] !== urlSegs[i]) {
          prefix = false;
          break;
        }
      }
    }

    if (exact || prefix) {
      const confidence = exact ? 1.0 : 0.75;
      const cand = { route: r, confidence, reason: exact ? 'exact' : 'prefix' };
      // cùng confidence → route nào dài (cụ thể) hơn thắng: /orders/{order} > /orders
      const better =
        !best ||
        cand.confidence > best.confidence ||
        (cand.confidence === best.confidence && rSegs.length > bestSegs);
      if (better) {
        best = cand;
        bestSegs = rSegs.length;
      }
    }
  }
  return best;
}

/**
 * Tìm route theo tên — cho `route('name')` / `{{ route('name') }}`.
 * @returns {object|null}
 */
export function findRouteByName(name, routes) {
  if (!name) return null;
  return routes.find((r) => r.name === name) || null;
}

/** Tìm route theo controller@method — cho `action('X@y')`. */
export function findRouteByAction(action, routes) {
  if (!action) return null;
  return routes.find((r) => r.action === action) || null;
}

/** Render inventory gọn cho agent (không tràn context). */
export function renderRoutes(routes, max = 60) {
  if (!routes.length) return 'Không có route nào.';
  const lines = routes.slice(0, max).map((r) => {
    const mw = r.middleware.length ? ` [${r.middleware.join(',')}]` : '';
    const nm = r.name ? ` (${r.name})` : '';
    return `${r.method.padEnd(6)} /${r.uri}${nm} → ${r.action}${mw}`;
  });
  const more =
    routes.length > max
      ? `\n… (+${routes.length - max} routes — dùng filter cụ thể hơn)`
      : '';
  return `${lines.join('\n')}${more}`;
}
