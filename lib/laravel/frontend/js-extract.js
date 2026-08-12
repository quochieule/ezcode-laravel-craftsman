/**
 * JS extract — liệt kê exhaustively các "string contract" của frontend:
 * jQuery selectors, AJAX urls, global functions, data attributes.
 *
 * Đây là thế giới mà knowledge graph (symbol) không nhìn thấy: contract giữa
 * JS và backend là CHUỖI, không phải symbol. Parser đếm hết → LLM chỉ phán đoán
 * trên danh sách đầy đủ (phân công lao động: code lo liệt kê, model lo suy luận).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Tách các khối <script>...</script> từ nội dung blade (có thể nhiều khối). */
export function extractInlineScripts(content) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(content))) {
    const body = m[1] || '';
    if (body.trim()) out.push(body);
  }
  return out;
}

/** Lấy thuộc tính data-* từ HTML (data-url, data-id, data-action...). */
export function extractDataAttrs(content) {
  const out = [];
  const re = /\bdata-([\w-]+)\s*=\s*["']([^"']*)["']/gi;
  let m;
  while ((m = re.exec(content))) {
    if (m[2].trim()) out.push({ attr: m[1], value: m[2].trim() });
  }
  return out;
}

/** Lấy form action + method (form gửi thẳng không qua JS).
 * Lưu ý: PHP `$order->id` chứa `>` — regex tag phải đi qua được `->`. */
export function extractFormActions(content) {
  const out = [];
  const re = /<form\b[^>]*?(?:->[^>]*?)*>/gi;
  let m;
  while ((m = re.exec(content))) {
    const tag = m[0];
    // capture theo ĐÚNG loại dấu nháy — value có thể chứa nháy còn lại (route('x'))
    const action = /action\s*=\s*(["'])(.*?)\1/i.exec(tag);
    const method = /method\s*=\s*(["'])(.*?)\1/i.exec(tag);
    if (action)
      out.push({
        action: action[2],
        method: method?.[2]?.toUpperCase() || 'GET',
      });
  }
  return out;
}

/**
 * Extract contracts từ 1 khối JS (file .js hoặc script inline).
 * @param {string} js
 * @returns {{selectors:Array<{sel:string, delegated:boolean, dynamic:boolean}>, urls:Array<{url:string, kind:string, dynamic:boolean}>, routeNames:string[], functions:string[], hasCsrfSetup:boolean}}
 */
export function extractJs(js) {
  const selectors = [];
  const urls = [];
  const routeNames = [];
  const functions = [];

  // ── jQuery selectors ──
  // $('...') / $("...") / jQuery('...') — không bắt selector dính biến
  // jQuery selectors: $('...') / $("...") / jQuery('...') — dấu ) đóng có thể thiếu khi
  // selector được ghép chuỗi ($('#' + id + '-form')) — dò tail để đánh dấu dynamic.
  const selRe = /(?:jQuery|\$)\s*\(\s*(['"])([^'"]{1,120})\1\s*\)?/g;
  let m;
  while ((m = selRe.exec(js))) {
    const sel = m[2];
    // bỏ selector môi trường (document/window/this) — không phải DOM target
    if (/^(document|window|this|body)$/.test(sel)) continue;
    const prev = js.slice(Math.max(0, m.index - 60), m.index);
    const delegated =
      /\.on\s*\(\s*['"][^'"]+['"]\s*,\s*$/.test(prev) ||
      /\$\s*\(\s*document\s*\)/.test(prev) ||
      /\$\s*\(\s*['"]?(?:body|document)['"]?\s*\)\s*\.on/.test(
        prev + js.slice(m.index, m.index + 20),
      );
    // selector ghép chuỗi ('#' + id + '-form') — dò phần đuôi sau dấu nháy
    const tail = js.slice(m.index + m[0].length, m.index + m[0].length + 40);
    const dynamic =
      sel.includes(' + ') ||
      sel.includes('${') ||
      sel.includes('{{') ||
      /^\s*\+/.test(tail) ||
      /\+\s*['"]/.test(tail);
    selectors.push({ sel, delegated, dynamic });
  }

  // $(document).on('click', '.x', ...) — dạng delegated 2 tham số
  const delRe =
    /\$\s*\(\s*document\s*\)\s*\.on\s*\(\s*['"][^'"]+['"]\s*,\s*(['"])([^'"]{1,120})\1/g;
  while ((m = delRe.exec(js)))
    selectors.push({ sel: m[2], delegated: true, dynamic: false });

  // ── AJAX urls ──
  // Lưu ý: URL ghép chuỗi ('/admin/orders/' + id + '/approve') bị regex cắt tại dấu nháy
  // đầu — phải dò phần đuôi sau dấu nháy để đánh dấu dynamic, không được coi là URL hoàn chỉnh.
  const urlPatterns = [
    {
      re: /\$\s*\.\s*(?:ajax|get|post|getJSON|getScript)\s*\(\s*(['"])([^'"]{1,300})\1/g,
      kind: 'ajax-short',
    },
    { re: /url\s*:\s*(['"])([^'"]{1,300})\1/g, kind: 'url-key' },
  ];
  for (const { re, kind } of urlPatterns) {
    let mm;
    while ((mm = re.exec(js))) {
      const url = mm[2];
      // dò tiếp sau dấu nháy đóng: có dấu + / {{ / ${ là URL được ghép động
      const tail = js.slice(
        mm.index + mm[0].length,
        mm.index + mm[0].length + 80,
      );
      const dynamic =
        url.includes('{{') ||
        url.includes('${') ||
        /^\s*\+/.test(tail) ||
        /\+\s*['"]/.test(tail.slice(0, 40));
      urls.push({ url, kind, dynamic });
    }
  }

  // route('name') / {{ route('name') }} — trong JS inline blade
  const routeRe = /route\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = routeRe.exec(js))) routeNames.push(m[1]);

  // action('Controller@method')
  const actionRe = /action\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = actionRe.exec(js)))
    urls.push({ url: `action:${m[1]}`, kind: 'action', dynamic: false });

  // ── Global functions ──
  const fnRe =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|window\.([A-Za-z_$][\w$]*)\s*=|const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\()/g;
  while ((m = fnRe.exec(js))) {
    const name = m[1] || m[2] || m[3] || m[4];
    if (name && !functions.includes(name)) functions.push(name);
  }

  // ── CSRF setup ──
  const hasCsrfSetup = /X-CSRF-TOKEN|csrf-token|csrfToken/.test(js);

  return { selectors, urls, routeNames, functions, hasCsrfSetup };
}

/** Đệ quy liệt kê file .js trong thư mục (giới hạn depth + số lượng). */
export async function scanJsFiles(dir, depth = 4, limit = 200) {
  const out = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= limit) return out;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name.startsWith('.') ||
          e.name === 'dist' ||
          e.name === 'build'
        )
          continue;
        if (depth > 0)
          out.push(...(await scanJsFiles(p, depth - 1, limit - out.length)));
      } else if (e.name.endsWith('.js')) {
        out.push(p);
      }
    }
  } catch {
    /* skip */
  }
  return out;
}

/**
 * Scan toàn bộ frontend của repo: blade (inline script + form + data-attrs)
 * + file JS (public/js, resources/js).
 * @returns {Promise<{files:Array, allSelectors:Array, allUrls:Array, allFunctions:Array, csrfSetup:boolean}>}
 */
export async function scanFrontend(cwd) {
  const { buildViewGraph } = await import('./blade-graph.js');
  const { readFile: rf } = await import('node:fs/promises');
  const viewsRoot = join(cwd, 'resources', 'views');
  // buildViewGraph trả { files, map, graph } — chỉ lấy phần map tên-view → nội dung
  const viewResult = await buildViewGraph(viewsRoot);
  const graph = viewResult.graph;

  const files = [];
  const allSelectors = [];
  const allUrls = [];
  const allFunctions = [];
  const allRouteNames = [];
  let csrfSetup = false;

  // 1. Blade: inline scripts + forms + data attrs
  for (const [viewName, g] of Object.entries(graph)) {
    const content = await rf(g.path, 'utf8').catch(() => '');
    const scripts = extractInlineScripts(content);
    for (const s of scripts) {
      const r = extractJs(s);
      files.push({ path: g.path, kind: 'blade-inline', view: viewName, ...r });
      allSelectors.push(...r.selectors);
      allUrls.push(...r.urls);
      allFunctions.push(...r.functions);
      allRouteNames.push(...r.routeNames);
      if (r.hasCsrfSetup) csrfSetup = true;
    }
    const forms = extractFormActions(content);
    const attrs = extractDataAttrs(content);
    if (forms.length || attrs.length) {
      files.push({
        path: g.path,
        kind: 'blade-html',
        view: viewName,
        forms,
        dataAttrs: attrs,
      });
    }
    for (const f of forms)
      allUrls.push({ url: f.action, kind: 'form-action', dynamic: false });
  }

  // 2. File JS riêng
  const jsDirs = [join(cwd, 'public', 'js'), join(cwd, 'resources', 'js')];
  for (const dir of jsDirs) {
    const jsFiles = await scanJsFiles(dir);
    for (const f of jsFiles) {
      const content = await rf(f, 'utf8').catch(() => '');
      const r = extractJs(content);
      files.push({ path: f, kind: 'js-file', ...r });
      allSelectors.push(...r.selectors);
      allUrls.push(...r.urls);
      allFunctions.push(...r.functions);
      allRouteNames.push(...r.routeNames);
      if (r.hasCsrfSetup) csrfSetup = true;
    }
  }

  return {
    files,
    allSelectors,
    allUrls,
    allFunctions,
    allRouteNames,
    csrfSetup,
    views: Object.keys(graph),
  };
}
