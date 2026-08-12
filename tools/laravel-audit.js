/**
 * laravel_audit — dead code audit 3 mức (đặc tả §6.10).
 *
 * 🔴 broken (mắt xích đứt thật) · 🟡 possibly-dead · 🟢 used
 * Alive-set từ routes — tránh false positive kiểu "grep không thấy = dead".
 */
import { loadRoutesSafe } from '../lib/laravel/routes.js';
import { scanFrontend } from '../lib/laravel/frontend/js-extract.js';
import {
  buildContractMap,
  renderContractMap,
} from '../lib/laravel/frontend/contract-match.js';
import {
  buildViewGraph,
  collectAllViewContent,
} from '../lib/laravel/frontend/blade-graph.js';
import {
  audit,
  renderAudit,
  findUnusedJsFunctions,
} from '../lib/laravel/audit/dead-code.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  name: 'laravel_audit',
  label: 'Laravel Audit',
  description:
    'Audit dead code + broken links theo 3 mức: 🔴 broken (JS gọi URL không có route, selector ' +
    'không có trong views, controller@method không tồn tại) · 🟡 possibly-dead (controller method ' +
    'không route nào trỏ tới, JS function không ai gọi — có thể sống vì API ngoài/scheduled) · 🟢 used. ' +
    'Alive-set từ route:list nên KHÔNG báo nhầm code đang được route dùng. Dùng khi dọn code, tìm ' +
    'dead code, hoặc kiểm tra "còn gì thừa" trước refactor.',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['all', 'frontend', 'backend'],
        default: 'all',
        description:
          'all = broken + possibly-dead · frontend = selector/url/js-functions · backend = controller methods.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
  },
  promptSnippet:
    'laravel_audit(scope?) — dead code 3 mức + broken links (alive-set aware)',
  promptGuidelines: [
    'Khi user hỏi "có dead code không / dọn code thừa" — gọi laravel_audit, không tự grep.',
    '🟡 possibly-dead KHÔNG được xóa ngay — phải xác minh thêm (API ngoài, scheduled, chuỗi động) rồi hỏi user.',
    '🔴 broken là bug tiềm ẩn — nên sửa hoặc xóa, không bỏ qua.',
  ],

  async execute(_id, params, signal, _onUpdate, ctx) {
    const resolved = await resolveRootOrError(params, ctx);
    if (!resolved.ok) return resolved;
    const root = resolved.root;
    if (!(await isLaravelRepo(root))) {
      return {
        content: [{ type: 'text', text: `"${root}" không phải repo Laravel.` }],
      };
    }

    const opts = settingsOpts(ctx);
    const scope = params.scope || 'all';
    try {
      const routes = await loadRoutesSafe(root, opts);
      const frontend = await scanFrontend(root);
      const viewResult = await buildViewGraph(join(root, 'resources', 'views'));
      const domHtml = await collectAllViewContent(viewResult);
      const contractMap = buildContractMap({ routes, frontend, domHtml });

      const result = audit({
        contractMap,
        routes,
        controllerFiles: await loadControllerFiles(root),
      });
      const lines = [];

      if (scope === 'frontend' || scope === 'all') {
        lines.push('── FRONTEND ──');
        // JS functions không ai gọi
        const jsTexts = [];
        for (const f of frontend.files) {
          if (f.kind === 'js-file' || f.kind === 'blade-inline') {
            const content = await readFile(f.path, 'utf8').catch(() => '');
            if (content) jsTexts.push(content);
          }
        }
        const unused = findUnusedJsFunctions(frontend.files, jsTexts);
        if (unused.length) {
          lines.push(`🟡 JS functions không ai gọi (${unused.length}):`);
          for (const u of unused.slice(0, 20))
            lines.push(`  - ${u.name} (khai báo: ${u.declaredIn.join(', ')})`);
        }
        lines.push(renderContractMap(contractMap));
      }
      if (scope === 'backend' || scope === 'all') {
        lines.push('\n── BACKEND ──');
        const backend = {
          ...result,
          broken: result.broken.filter((b) => b.type === 'url'),
          possiblyDead: result.possiblyDead,
        };
        lines.push(
          renderAudit(backend).replace('🔴 BROKEN', '🔴 BROKEN (url)'),
        );
      }
      if (scope === 'all') {
        lines.push('\n── TỔNG HỢP ──');
        lines.push(renderAudit(result));
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};

async function loadControllerFiles(root) {
  const { readdir } = await import('node:fs/promises');
  const dir = join(root, 'app', 'Http', 'Controllers');
  const out = [];
  async function walk(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.php')) {
        const content = await readFile(p, 'utf8').catch(() => '');
        if (content) out.push({ path: p.replace(/\\/g, '/'), content });
      }
    }
  }
  await walk(dir);
  return out;
}
