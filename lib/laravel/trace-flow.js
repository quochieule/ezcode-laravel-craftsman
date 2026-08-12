/**
 * trace-flow.js — trace workflow end-to-end (đặc tả §9 laravel_trace_flow).
 *
 * Nhập 1 điểm xuất phát (URL, selector, route name, controller@method):
 * dựng chuỗi mắt xích user workflow, mỗi mắt xích verify được ✓/✗.
 *
 *   selector → handler (JS) → url → route → controller@method → (service/model)
 *   → response → callback → DOM target
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { matchUrlToRoute, normalizeUri } from './routes.js';
import { extractJs } from './frontend/js-extract.js';
import { collectAllViewContent } from './frontend/blade-graph.js';
import { extractDomTokens } from './frontend/contract-match.js';

/** Tìm file JS (public/js + resources/js) có chứa selector/url. */
async function findJsFilesWith(root, needle) {
  const found = [];
  for (const dir of [
    join(root, 'public', 'js'),
    join(root, 'resources', 'js'),
  ]) {
    const files = await walkJs(dir);
    for (const f of files) {
      const content = await readFile(f, 'utf8').catch(() => '');
      if (content.includes(needle))
        found.push({ file: f.replace(/\\/g, '/'), content });
    }
  }
  return found;
}

async function walkJs(dir, depth = 4) {
  const out = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (
          e.name.startsWith('.') ||
          e.name === 'node_modules' ||
          e.name === 'dist'
        )
          continue;
        if (depth > 0) out.push(...(await walkJs(p, depth - 1)));
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
 * Trace 1 workflow từ điểm xuất phát.
 * @param {object} input { root, start, routes, frontendScan }
 * @returns {Promise<{chain:Array<{link:string, detail:string, status:string}>, broken:Array}>}
 */
export async function traceFlow({ root, start, routes, frontendScan }) {
  const chain = [];
  const broken = [];
  const dom = extractDomTokens(
    await collectAllViewContent(frontendScan.graphResult || {}),
  );

  const add = (link, detail, status = 'ok') => {
    chain.push({ link, detail, status });
    if (status !== 'ok') broken.push({ link, detail });
  };

  const s = String(start || '').trim();

  // ── 1. Xác định điểm xuất phát ──
  let currentSelector = null;
  let currentUrl = null;
  let currentRoute = null;

  if (s.startsWith('#')) {
    currentSelector = s;
    add('start', `selector ${s}`, dom.ids.has(s.slice(1)) ? 'ok' : 'missing');
  } else if (s.startsWith('/') || /^https?:/.test(s) || s.includes('{')) {
    currentUrl = s;
    const m = matchUrlToRoute(s, routes);
    if (m) {
      currentRoute = m.route;
      add('url→route', `/${m.route.uri} (${m.reason}, conf ${m.confidence})`);
    } else {
      add('url→route', `${s}`, 'broken');
    }
  } else if (routes.find((r) => r.name === s)) {
    currentRoute = routes.find((r) => r.name === s);
    add('route', `/${currentRoute.uri} (${currentRoute.name})`);
  } else {
    // có thể là controller@method
    const byAction = routes.find((r) => r.action === s);
    if (byAction) {
      currentRoute = byAction;
      add('route', `/${byAction.uri} → ${byAction.action}`);
    } else {
      add(
        'start',
        `"${s}" không nhận diện được (selector/url/route/action)`,
        'broken',
      );
      return { chain, broken };
    }
  }

  // ── 2. JS handler cho selector / url ──
  const needle =
    currentSelector ||
    normalizeUri(currentUrl || '')
      .split('/')
      .pop() ||
    '';
  if (needle) {
    const jsFiles = await findJsFilesWith(root, needle);
    if (jsFiles.length) {
      for (const { file, content } of jsFiles) {
        const parsed = extractJs(content);
        const handler = parsed.selectors.find((x) => x.sel === needle);
        add(
          'js-handler',
          `${file}${handler ? ` → ${handler.delegated ? 'delegated' : 'direct'}` : ''}`,
          handler ? 'ok' : 'warn',
        );
        // url từ handler này
        for (const u of parsed.urls) {
          const m = matchUrlToRoute(u.url, routes);
          add(
            'js→url',
            `${u.url} → ${m ? `/${m.route.uri}` : 'KHÔNG có route'}`,
            m ? 'ok' : 'broken',
          );
          if (m && !currentRoute) currentRoute = m.route;
        }
      }
    } else {
      add('js-handler', `không tìm thấy "${needle}" trong file JS`, 'broken');
    }
  }

  // ── 3. Controller method tồn tại ──
  if (currentRoute?.action && currentRoute.action !== 'closure') {
    const mm = /([A-Za-z_\\][\w\\]*)@([\w]+)/.exec(currentRoute.action);
    if (mm) {
      const [cls, method] = [mm[1], mm[2]];
      const file = join(
        root,
        'app',
        'Http',
        'Controllers',
        `${cls.split('\\').pop()}.php`,
      );
      const content = await readFile(file, 'utf8').catch(() => '');
      if (content && new RegExp(`function\\s+${method}\\s*\\(`).test(content)) {
        add('controller', `${cls}@${method} ✓`);
        // response json/redirect → callback
        if (/response\(\)->json|->json\(/.test(content))
          add('response', 'JSON response');
        else if (/redirect\(|->back\(|->route\(/.test(content))
          add('response', 'redirect');
      } else {
        add('controller', `${cls}@${method} — KHÔNG tồn tại`, 'broken');
      }
    }
  }

  return { chain, broken };
}

/** Render chuỗi mắt xích. */
export function renderTrace(trace) {
  const lines = trace.chain.map((c) => {
    const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '🟡' : '🔴';
    return `  ${icon} ${c.link} — ${c.detail}`;
  });
  return `WORKFLOW TRACE:\n${lines.join('\n')}\n${trace.broken.length ? `\n🔴 ${trace.broken.length} mắt xích đứt.` : '\nToàn bộ mắt xích liền mạch.'}`;
}
