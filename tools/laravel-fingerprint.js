/**
 * laravel_fingerprint — chân dung dự án Laravel: version, packages, conventions
 * (logging style, validation, structure, auth, tests, frontend).
 *
 * Deterministic 100% — agent KHÔNG phải đoán dự án đang dùng gì.
 */
import {
  buildFingerprint,
  renderFingerprint,
} from '../lib/laravel/fingerprint.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';

export default {
  name: 'laravel_fingerprint',
  label: 'Laravel Fingerprint',
  description:
    'Chân dung dự án Laravel hiện tại: version, key packages, conventions (FormRequest? ' +
    'Service layer? Sanctum? Pest/PHPUnit? log kiểu Log::/logger()/activity()?), cấu trúc ' +
    'thư mục, frontend (public/js, blade layouts). Gọi ĐẦU TIÊN khi làm việc với repo Laravel ' +
    'lạ — để không đoán convention. Deterministic, đọc từ composer.json + artisan about + scan.',
  parameters: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
  },
  promptSnippet:
    'laravel_fingerprint() — chân dung dự án: version, packages, conventions',
  promptGuidelines: [
    'Gọi laravel_fingerprint khi bắt đầu làm việc với repo Laravel để biết convention trước khi viết code.',
    'Trước khi quyết định "dự án này log kiểu gì / dùng FormRequest không / test bằng gì" — phải hỏi fingerprint, không đoán.',
  ],

  async execute(_id, params, _signal, _onUpdate, ctx) {
    const resolved = await resolveRootOrError(params, ctx);
    if (!resolved.ok) return resolved;
    const root = resolved.root;

    if (!(await isLaravelRepo(root))) {
      return {
        content: [
          {
            type: 'text',
            text: `"${root}" không phải repo Laravel (thiếu artisan/composer.json). Laravel Craftsman chỉ chạy trên repo Laravel.`,
          },
        ],
      };
    }

    const opts = settingsOpts(ctx);
    try {
      const fp = await buildFingerprint(root, opts);
      return { content: [{ type: 'text', text: renderFingerprint(fp) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};
