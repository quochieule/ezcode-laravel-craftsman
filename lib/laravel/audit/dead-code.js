/**
 * dead-code.js — audit dead code 3 mức (đặc tả §6.10).
 *
 * 🟢 used — bằng chứng trực tiếp
 * 🟡 possibly-dead — không tìm thấy ref sau khi check TOÀN BỘ alive-set + view graph
 * 🔴 broken — mắt xích đứt THẬT (JS gọi URL không có route, selector không có DOM ở đâu cả)
 *
 * Alive-set từ string registries — tránh false positive kiểu "grep không thấy = dead":
 * routes (controller@method), providers, schedule, events, view()/route()/@include, JS urls.
 */

/** ── Alive-set backend ── */

/** Controller methods được route trỏ tới (từ route inventory). */
export function aliveFromRoutes(routes) {
  const alive = new Set();
  for (const r of routes) {
    const m = /([A-Za-z_][\w]*)@([\w]+)$/.exec(r.action || '');
    if (m) alive.add(`${m[1]}@${m[2]}`);
    const m2 = /([A-Za-z_][\w]*Controller)@([\w]+)/.exec(r.action || '');
    if (m2) alive.add(m2[0]);
  }
  return alive;
}

/** Phương thức controller khai báo trong file (regex đơn giản). */
export function controllerMethods(content) {
  const out = new Set();
  let m;
  const re = /function\s+([A-Za-z_][\w]*)\s*\(/g;
  while ((m = re.exec(content))) out.add(m[1]);
  return out;
}

/** ── Alive-set frontend (JS functions có caller) ── */

/**
 * Tìm JS function không được gọi ở ĐÂU (mọi blade + mọi js).
 * @param {Array<{path:string, kind:string, functions:string[]}>} jsFiles  kết quả scanFrontend().files
 * @param {string[]} allJsText  nội dung mọi file js + inline script
 */
export function findUnusedJsFunctions(jsFiles, allJsText) {
  const declared = new Map(); // name → [paths]
  for (const f of jsFiles) {
    for (const fn of f.functions || []) {
      if (!declared.has(fn)) declared.set(fn, []);
      declared.get(fn).push(f.path);
    }
  }
  const corpus = allJsText.join('\n');
  const unused = [];
  for (const [name, paths] of declared) {
    // đếm số lần xuất hiện trong toàn bộ corpus — 1 = chỉ khai báo, không ai gọi
    const count = (corpus.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    if (count <= 1) {
      unused.push({ name, declaredIn: paths, refs: count });
    }
  }
  return unused;
}

/** ── Audit tổng hợp ── */

/**
 * Audit frontend+backend từ dữ liệu đã scan.
 * @param {object} input { contractMap, routes, controllerFiles: {path, content}[] }
 * @returns {{used:Array, possiblyDead:Array, broken:Array}}
 */
export function audit({ contractMap, routes = [], controllerFiles = [] }) {
  const used = [];
  const possiblyDead = [];
  const broken = [];

  // 🟢 used — bằng chứng trực tiếp từ contract map
  for (const u of contractMap?.urls || []) {
    if (u.match) {
      used.push({
        type: 'url',
        what: u.url,
        evidence: `khớp route /${u.match.route.uri}`,
      });
    }
  }
  for (const sel of contractMap?.selectors || []) {
    if (sel.status === 'found')
      used.push({
        type: 'selector',
        what: sel.sel,
        evidence: 'có trong views',
      });
  }

  // 🔴 broken links từ contract map
  for (const u of contractMap?.urls || []) {
    if (!u.match && u.kind !== 'route-name' && !u.dynamic) {
      broken.push({
        type: 'url',
        what: u.url,
        evidence: `JS gọi URL không có route (${u.kind})`,
      });
    }
  }
  for (const s of contractMap?.selectors || []) {
    if (s.status === 'missing') {
      broken.push({
        type: 'selector',
        what: s.sel,
        evidence: `selector không có trong views (thiếu: ${(s.missingTokens || []).join(', ')})`,
      });
    }
  }

  // 🟡 controller methods không nằm trong alive-set (routes)
  const alive = aliveFromRoutes(routes);
  for (const { path, content } of controllerFiles) {
    for (const method of controllerMethods(content)) {
      if (
        [
          '__construct',
          'index',
          'create',
          'store',
          'show',
          'edit',
          'update',
          'destroy',
          'invoke',
          'middleware',
        ].includes(method)
      )
        continue;
      const full = `${path.split(/[\\/]/).pop().replace('.php', '')}@${method}`;
      if (
        !alive.has(full) &&
        ![...alive].some((a) => a.endsWith(`@${method}`))
      ) {
        possiblyDead.push({
          type: 'controller-method',
          what: `${path}:${method}`,
          evidence: `không route nào trỏ tới (alive-set: ${alive.size} methods)`,
        });
      }
    }
  }

  return { used, possiblyDead, broken };
}

/** Render audit gọn. */
export function renderAudit(result) {
  const lines = [
    `🔴 BROKEN (${result.broken.length}) — mắt xích đứt thật:`,
    ...result.broken.map((b) => `  - ${b.what} — ${b.evidence}`),
    `\n🟡 POSSIBLY-DEAD (${result.possiblyDead.length}) — cần xác minh thêm:`,
    ...result.possiblyDead.map((p) => `  - ${p.what} — ${p.evidence}`),
    `\n🟢 USED: ${result.used.length} (bằng chứng trực tiếp — không liệt kê chi tiết)`,
  ];
  return lines.join('\n');
}
