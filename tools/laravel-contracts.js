/**
 * laravel_contracts — bản đồ frontend ↔ backend: blade ↔ JS ↔ routes.
 *
 * ★ Đây là thứ Claude Code/grep không làm được: jQuery selector và AJAX url là
 * CHUỖI — parser đếm exhaustively rồi đối chiếu với route inventory (artisan)
 * và DOM toàn bộ views (layout + partials + AJAX partials).
 */
import { loadRoutesSafe } from '../lib/laravel/routes.js';
import { scanFrontend } from '../lib/laravel/frontend/js-extract.js';
import {
  buildContractMap,
  renderContractMap,
} from '../lib/laravel/frontend/contract-match.js';
import { collectAllViewContent } from '../lib/laravel/frontend/blade-graph.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';
import { join } from 'node:path';

export default {
  name: 'laravel_contracts',
  label: 'Laravel Contracts',
  description:
    "Bản đồ contract giữa frontend và backend: mọi jQuery selector + AJAX url + route('name') " +
    'trong blade/JS được đối chiếu với route thật (php artisan route:list) và DOM toàn bộ views. ' +
    'Phát hiện 🔴 broken links (JS gọi URL không có route, selector không có trong DOM) và 🟡 ' +
    'route() chưa resolve. Gọi khi cần sửa frontend, thêm feature chạm JS/AJAX, hoặc tìm dead code.',
  parameters: {
    type: 'object',
    properties: {
      scope: {
        type: 'string',
        enum: ['summary', 'broken', 'urls', 'selectors'],
        default: 'summary',
        description:
          'summary = tóm tắt + broken · broken = chỉ danh sách hỏng · urls/selectors = chi tiết.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
  },
  promptSnippet:
    'laravel_contracts(scope?) — blade↔JS↔routes: tìm broken links/dead selectors',
  promptGuidelines: [
    'Trước khi sửa JS/AJAX: gọi laravel_contracts để biết URL/selector đang trỏ đi đâu và có khớp không.',
    'Khi nghi ngờ dead code frontend: laravel_contracts trả selectors missing + urls broken — dùng làm bằng chứng.',
  ],

  async execute(_id, params, _signal, _onUpdate, ctx) {
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
      const [routes, frontend] = await Promise.all([
        loadRoutesSafe(root, opts),
        scanFrontend(root),
      ]);

      const domHtml = await collectAllViewContent(
        await import('../lib/laravel/frontend/blade-graph.js').then((m) =>
          m.buildViewGraph(join(root, 'resources', 'views')),
        ),
      );

      const map = buildContractMap({ routes, frontend, domHtml });
      const scope = params.scope || 'summary';

      if (scope === 'broken') {
        const brokenUrls = map.urls.filter(
          (u) => !u.match && u.kind !== 'route-name',
        );
        const missingSels = map.selectors.filter((s) => s.status === 'missing');
        const lines = [];
        lines.push(`🔴 URLs không khớp route (${brokenUrls.length}):`);
        for (const u of brokenUrls) lines.push(`  - ${u.url} [${u.kind}]`);
        lines.push(
          `🔴 Selectors không có trong views (${missingSels.length}):`,
        );
        for (const s of missingSels)
          lines.push(
            `  - ${s.sel}${s.missingTokens ? ` (thiếu: ${s.missingTokens.join(', ')})` : ''}`,
          );
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (scope === 'urls') {
        const lines = map.urls.slice(0, 60).map((u) => {
          const status = u.match
            ? `→ ${u.match.route.method} /${u.match.route.uri} (${u.match.reason}, conf ${u.match.confidence})`
            : u.kind === 'route-name'
              ? '→ 🟡 route name chưa resolve'
              : '→ 🔴 KHÔNG khớp route';
          return `- ${u.url} [${u.kind}] ${status}`;
        });
        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n') || 'Không có URL nào trong frontend.',
            },
          ],
        };
      }

      if (scope === 'selectors') {
        const lines = map.selectors
          .slice(0, 60)
          .map(
            (s) =>
              `- ${s.sel} [${s.status}${s.delegated ? ', delegated' : ''}]${s.missingTokens ? ` thiếu: ${s.missingTokens.join(', ')}` : ''}`,
          );
        return {
          content: [
            {
              type: 'text',
              text: lines.join('\n') || 'Không có selector nào.',
            },
          ],
        };
      }

      return { content: [{ type: 'text', text: renderContractMap(map) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};
