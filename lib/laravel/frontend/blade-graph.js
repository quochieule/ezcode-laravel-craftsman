/**
 * Blade graph — cây view: layout → section → partial.
 *
 * Parse toàn bộ file .blade.php dưới resources/views:
 *   - @extends('layout') / @include('partial') / @includeIf / @component
 *   - <x-component> (Blade components)
 *   - @yield / @section / @push / @stack / @each
 *
 * Dùng để: (1) resolve tên view → file thật; (2) biết 1 blade được render trong
 * layout nào (để tìm DOM target của JS khi partial render qua AJAX).
 * Regex-based là chủ ý — cú pháp Blade rất đều.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Tên view từ path: resources/views/admin/orders/detail.blade.php → admin.orders.detail */
export function viewNameFromPath(absPath, viewsRoot) {
  const rel = relative(viewsRoot, absPath).replace(/\\/g, '/');
  return rel.replace(/\.blade\.php$/, '').replace(/\//g, '.');
}

/** Đệ quy liệt kê mọi file .blade.php dưới viewsRoot. */
export async function scanBladeFiles(viewsRoot, depth = 8) {
  const out = [];
  try {
    const entries = await readdir(viewsRoot, { withFileTypes: true });
    for (const e of entries) {
      const p = join(viewsRoot, e.name);
      if (e.isDirectory()) {
        if (depth > 0) out.push(...(await scanBladeFiles(p, depth - 1)));
      } else if (e.name.endsWith('.blade.php')) {
        out.push(p);
      }
    }
  } catch {
    /* views không tồn tại */
  }
  return out;
}

/** Parse 1 file blade → các directive quan hệ view. */
export function parseBlade(content) {
  const grab = (re) => {
    const out = [];
    let m;
    while ((m = re.exec(content))) out.push(m[1]);
    return out;
  };
  return {
    extends: grab(/@extends\s*\(\s*['"]([^'"]+)['"]/g),
    includes: grab(/@include(?:If|When|Unless)?\s*\(\s*['"]([^'"]+)['"]/g),
    components: grab(/@component\s*\(\s*['"]([^'"]+)['"]/g),
    xComponents: grab(/<x-([a-z0-9-.:]+)[\s>]/gi).map((n) => n.toLowerCase()),
    yields: grab(/@yield\s*\(\s*['"]([^'"]+)['"]/g),
    sections: grab(/@section\s*\(\s*['"]([^'"]+)['"]/g),
    pushes: grab(/@push\s*\(\s*['"]([^'"]+)['"]/g),
    stacks: grab(/@stack\s*\(\s*['"]([^'"]+)['"]/g),
    each: grab(/@each\s*\(\s*['"]([^'"]+)['"]/g),
  };
}

/**
 * Build view graph đầy đủ.
 * @param {string} viewsRoot
 * @returns {Promise<{files:string[], map:object, graph:object}>}
 *   map: viewName → absPath · graph: viewName → {extends, includes, components, ...}
 */
export async function buildViewGraph(viewsRoot) {
  const files = await scanBladeFiles(viewsRoot);
  const map = {};
  const graph = {};
  for (const f of files) {
    const name = viewNameFromPath(f, viewsRoot);
    map[name] = f;
    const content = await readFile(f, 'utf8').catch(() => '');
    graph[name] = { ...parseBlade(content), path: f };
  }
  return { files, map, graph };
}

/** Resolve tên view (có thể có sub-dir) → absPath. */
export function resolveView(viewName, map) {
  if (!viewName) return null;
  const normalized = String(viewName).replace(/\.blade\.php$/, '');
  return map[normalized] || null;
}

/**
 * Gộp nội dung toàn bộ views (layout + partials + section content)
 * để so khớp selector — dynamic DOM từ AJAX partials cũng nằm trong này.
 * Chấp nhận cả kết quả buildViewGraph() lẫn inner graph.
 * @returns {Promise<string>} HTML gộp
 */
export async function collectAllViewContent(graphOrResult) {
  const g = graphOrResult?.graph || graphOrResult || {};
  const parts = [];
  for (const name of Object.keys(g)) {
    try {
      parts.push(await readFile(g[name].path, 'utf8'));
    } catch {
      /* skip */
    }
  }
  return parts.join('\n');
}

/** Render cây view gọn (cha → con). */
export function renderViewTree(graph, max = 50) {
  const lines = [];
  for (const [name, g] of Object.entries(graph)) {
    const kids = [...g.includes, ...g.components, ...g.xComponents].filter(
      Boolean,
    );
    const ext = g.extends.length ? ` extends:${g.extends.join(',')}` : '';
    lines.push(
      `- ${name}${ext}${kids.length ? ` → includes: ${kids.join(', ')}` : ''}`,
    );
    if (lines.length >= max) break;
  }
  return lines.join('\n') || 'Không có blade nào.';
}
