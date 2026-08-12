/**
 * laravel_trace_flow — trace workflow end-to-end (đặc tả §9).
 *
 * Nhập 1 điểm (selector/url/route name/controller@method) → chuỗi mắt xích:
 * selector → JS handler → url → route → controller@method → response → callback.
 * Mỗi mắt xích verify ✓/✗ — chỗ đứt = dead code hoặc bug.
 */
import { traceFlow, renderTrace } from '../lib/laravel/trace-flow.js';
import { loadRoutesSafe } from '../lib/laravel/routes.js';
import { scanFrontend } from '../lib/laravel/frontend/js-extract.js';
import { buildViewGraph } from '../lib/laravel/frontend/blade-graph.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';
import { join } from 'node:path';

export default {
  name: 'laravel_trace_flow',
  label: 'Laravel Trace Flow',
  description:
    'Trace 1 workflow người dùng end-to-end theo chuỗi mắt xích: selector/url/route → JS handler → ' +
    'AJAX url → route thật → controller@method → response → DOM target. Mỗi mắt xích verify được ' +
    '✓/✗ — mắt xích đứt = dead code hoặc bug tiềm ẩn. Dùng để hiểu "bấm nút X thì chuyện gì xảy ra", ' +
    'tìm chỗ đứt, hoặc học luồng trước khi sửa.',
  parameters: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description:
          'REQUIRED. Điểm xuất phát: selector (#approve-order-btn), URL (/admin/orders/12/approve), route name (orders.approve) hoặc Controller@method.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
    required: ['start'],
  },
  promptSnippet:
    'laravel_trace_flow(start) — trace workflow: selector/url/route → ... → response',
  promptGuidelines: [
    'Trước khi sửa 1 luồng (form/button/ajax) — trace nó trước để biết mắt xích nào còn sống, mắt xích nào đứt.',
    'Kết quả có 🔴 broken → đó là dead code hoặc bug — báo cho user, không tự xóa.',
  ],

  async execute(_id, params, signal, _onUpdate, ctx) {
    const start = (params.start || '').trim();
    if (!start)
      return { content: [{ type: 'text', text: 'Error: start là bắt buộc.' }] };

    const resolved = await resolveRootOrError(params, ctx);
    if (!resolved.ok) return resolved;
    const root = resolved.root;
    if (!(await isLaravelRepo(root))) {
      return {
        content: [{ type: 'text', text: `"${root}" không phải repo Laravel.` }],
      };
    }

    const opts = settingsOpts(ctx);
    try {
      const [routes, frontend, viewResult] = await Promise.all([
        loadRoutesSafe(root, opts),
        scanFrontend(root),
        buildViewGraph(join(root, 'resources', 'views')),
      ]);
      frontend.graphResult = viewResult;
      const trace = await traceFlow({
        root,
        start,
        routes,
        frontendScan: frontend,
      });
      return { content: [{ type: 'text', text: renderTrace(trace) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};
