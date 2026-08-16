/**
 * laravel_reverify — ★ Re-Verification Protocol (đặc tả §6.11).
 *
 * Trả lời "kiểm tra lại / còn thiếu gì không?" bằng bảng per-item ✓/✗/?
 * 3 kênh độc lập: deterministic + adversarial fresh-eyes + reality.
 * KHÔNG BAO GIỜ trả "trông ổn" — phần "không kiểm tra được" bắt buộc khai báo.
 */
import { runRvp, gitDiffText } from '../lib/stages/rvp.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default {
  name: 'laravel_reverify',
  label: 'Laravel Re-Verify',
  description:
    '★ Re-Verification Protocol: kiểm tra LẠI công việc vừa làm bằng 3 kênh độc lập ' +
    '(deterministic ground truth + adversarial subagent fresh-eyes + reality check). ' +
    'Trả báo cáo per-item: ✓ xác minh · ✗ thiếu (kèm evidence) · ? không kiểm tra được. ' +
    'Gọi khi user nói "kiểm tra lại / còn thiếu gì / chắc chưa" — KHÔNG giải thích lại công việc.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'Yêu cầu gốc đã làm (để verifier biết phạm vi kiểm tra).',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Danh sách file đã sửa (đường dẫn tương đối).',
      },
      runTests: {
        type: 'boolean',
        description: 'Optional. Chạy php artisan test thật (chậm).',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
  },
  promptSnippet:
    'laravel_reverify(goal?, files?) — RVP 3 kênh: báo cáo per-item ✓/✗/?',
  promptGuidelines: [
    'Khi user yêu cầu kiểm tra lại — gọi laravel_reverify NGAY, không tự "soát lại" bằng cách đọc lại file.',
    'Báo cáo trả về có phần "?" (không kiểm tra được) — phải nêu rõ cho user, không giấu.',
    'Mọi mục ✗ phải được sửa trước khi báo xong.',
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

    const cfg = ctx.extensionSettings || {};
    const modelCfg = cfg.model_verifier || cfg.model_planner;
    const opts = settingsOpts(ctx);

    // Sub-agent thật (hướng (b)) cho verifier fresh-eyes — opt-in use_subagents.
    // Verifier có tool read → tự kiểm chứng evidence file:line thay vì tin diff
    // text → giảm false-missing → giảm vòng lặp reverify (71–73 vòng trên BizHub).
    let subagent = null;
    if (cfg.use_subagents === true || cfg.use_subagents === 'true') {
      const { createSubagentRunner } = await import('../lib/subagent.js');
      subagent = createSubagentRunner(ctx, cfg);
      if (!subagent.available) {
        console.warn(
          '[craftsman] use_subagents bật nhưng thiếu spawnSubagent/forkContext — fallback parallel calls',
        );
        subagent = null;
      }
    }

    // plan giả từ tham số: files đã sửa → deterministic check
    const plan = {
      files: Array.isArray(params.files) ? params.files : [],
      touchpoints: (Array.isArray(params.files) ? params.files : []).map(
        (f) => ({ item: 'modified', file: f, action: 'modify' }),
      ),
      tests: [],
      assumptions: [],
      unknowns: [],
    };

    const exec = async (args, o = {}) => {
      const php = opts.phpBin || 'php';
      const { stdout, stderr } = await execFileAsync(
        php,
        ['artisan', ...args],
        {
          cwd: root,
          timeout: o.timeoutMs ?? 60000,
          maxBuffer: 20 * 1024 * 1024,
          windowsHide: true,
        },
      ).catch((e) => {
        throw new Error((e.stderr || e.message).slice(0, 400));
      });
      return stdout + (stderr || '');
    };

    const diffText = await gitDiffText(root, async (args, o) => {
      const { stdout } = await execFileAsync('git', args, {
        cwd: root,
        timeout: o.timeoutMs ?? 15000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    }).catch(() => '');

    try {
      const result = await runRvp(
        {
          root,
          goal: params.goal || '',
          plan,
          checklistIds: [],
          diffText,
          runTests: !!params.runTests,
          exec,
        },
        {
          models:
            typeof ctx.createModelsCollection === 'function'
              ? ctx.createModelsCollection()
              : null,
          modelCfg,
          signal,
          subagent,
        },
      );

      // ── Learning (M8): mọi mục ✗ → check vĩnh viễn cho lần sau — "không xin lỗi, học" ──
      if (result.missing.length) {
        const { addLearnedCheck, addEpisode } =
          await import('../lib/memory.js');
        for (const m of result.missing) {
          await addLearnedCheck(root, {
            trigger: params.goal || '(reverify)',
            check: `${m.item} — ${m.evidence}`.slice(0, 200),
            source: 'rvp',
          }).catch(() => {});
        }
        await addEpisode(root, {
          task: `reverify: ${(params.goal || '').slice(0, 120)}`,
          intent: 'reverify',
          filesRead: [],
          planFiles: Array.isArray(params.files) ? params.files : [],
          missingCount: result.missing.length,
        }).catch(() => {});
      }

      return { content: [{ type: 'text', text: result.report }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};
