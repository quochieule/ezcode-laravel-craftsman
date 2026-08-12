/**
 * laravel_plan — ★ tool chính: pipeline đầy đủ (đặc tả §4).
 *
 * ② 3 prompt-critics → Requirements Map + gap registry (intent gaps → hỏi user)
 * ③ xử lý gap (câu hỏi kèm vết tìm)
 * ④ explorer (đọc có mục tiêu, facts → understanding map)
 * ⑤ 5 planners song song → hội đồng merge
 * ⑥ critic (blocking/advisory/score, claim verification, contract diff)
 * ⑦ gate: blocking → targeted re-explore → re-plan (≤ plan_rounds)
 * ⑧ học: lưu episode + knowledge
 */
import { loadRoutesSafe } from '../lib/laravel/routes.js';
import { scanMigrations, renderSchema } from '../lib/laravel/schema.js';
import {
  buildFingerprint,
  renderFingerprint,
} from '../lib/laravel/fingerprint.js';
import { scanFrontend } from '../lib/laravel/frontend/js-extract.js';
import {
  buildContractMap,
  renderContractMap,
} from '../lib/laravel/frontend/contract-match.js';
import {
  buildViewGraph,
  collectAllViewContent,
} from '../lib/laravel/frontend/blade-graph.js';
import { renderChecklist, checklistFor } from '../lib/laravel/blueprint.js';
import {
  settingsOpts,
  resolveRootOrError,
  isLaravelRepo,
} from '../lib/context.js';
import { cached, watchFilesFor } from '../lib/cache.js';
import { GapRegistry, gapsToQuestions } from '../lib/gap-registry.js';
import { UnderstandingMap } from '../lib/understanding-map.js';
import {
  runPromptCritics,
  renderRequirementsMap,
  requirementsToGaps,
} from '../lib/stages/prompt-critics.js';
import { explore, renderExplorerFacts } from '../lib/stages/explorer.js';
import { runPlanners, renderMergedPlan } from '../lib/stages/planners.js';
import { critic } from '../lib/stages/critic.js';
import { diffFromFiles } from '../lib/laravel/contract-diff.js';
import { sessionSummary, addEpisode } from '../lib/memory.js';
import { join } from 'node:path';

export default {
  name: 'laravel_plan',
  label: 'Laravel Plan',
  description:
    '★ Lập kế hoạch triển khai 1 yêu cầu trên repo Laravel theo pipeline đầy đủ: ' +
    '3 subagent phản biện prompt (bắt mơ hồ/thiếu) → hỏi user nếu cần làm rõ → explore code thật → ' +
    '5 subagent plan song song (kiến trúc sư/frontend contract/data/security/risk) → hội đồng merge → ' +
    'critic deterministic (hallucination filter, checklist coverage, claim verification, contract diff) ' +
    '→ plan kèm score + unknowns. Gọi TRƯỚC khi sửa code cho feature chạm nhiều tầng. ' +
    'Chạy 30–120s (scan + nhiều lượt LLM).',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'REQUIRED. Mục tiêu — mô tả feature/bugfix cần làm.',
      },
      featureType: {
        type: 'string',
        enum: [
          'api-endpoint',
          'model-relationship',
          'auth-route',
          'job-queue',
          'notification-mail',
          'command',
          'form-validation',
          'report-query',
        ],
        description:
          'Optional — loại feature để chọn checklist. Bỏ trống = tự nhận diện.',
      },
      context: {
        type: 'string',
        description: 'Optional. Ngữ cảnh thêm: ràng buộc, điều đã thử.',
      },
      skipQuestions: {
        type: 'boolean',
        description:
          'Optional. true = không hỏi user, đi tiếp với assumptions khai báo.',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
    required: ['goal'],
  },
  promptSnippet:
    'laravel_plan(goal, featureType?) — plan full-chain: critics → explore → 5 planners → critic',
  promptGuidelines: [
    'BẮT BUỘC gọi laravel_plan trước khi sửa code cho feature chạm nhiều tầng (route+controller+view+JS).',
    'Nếu laravel_plan trả về câu hỏi cần user trả lời → hỏi user rồi gọi LẠI với context bổ sung.',
    'Chỗ nào plan ghi unknowns/assumptions → phải kiểm tra trước khi làm tới đó.',
  ],

  async execute(_id, params, signal, _onUpdate, ctx) {
    const goal = (params.goal || '').trim();
    if (!goal)
      return { content: [{ type: 'text', text: 'Error: goal là bắt buộc.' }] };

    const resolved = await resolveRootOrError(params, ctx);
    if (!resolved.ok) return resolved;
    const root = resolved.root;
    if (!(await isLaravelRepo(root))) {
      return {
        content: [{ type: 'text', text: `"${root}" không phải repo Laravel.` }],
      };
    }

    const cfg = ctx.extensionSettings || {};
    const modelCfg = cfg.model_planner;
    if (!modelCfg?.provider || !modelCfg?.modelId) {
      return {
        content: [
          {
            type: 'text',
            text: 'Chưa cấu hình Planner model. Settings → Extensions → Laravel Craftsman → chọn model cho "Planner model".',
          },
        ],
      };
    }

    const opts = settingsOpts(ctx);
    const models = ctx.createModelsCollection();
    const maxRounds = Number(cfg.plan_rounds ?? 3);
    const exploreBudget = Number(cfg.explore_budget ?? 30);
    const registry = new GapRegistry();
    const umap = new UnderstandingMap();

    try {
      // ── Gather facts (cache theo mtime — cached() trả {value, cached}, phải unwrap) ──
      const [fpRes, schema, routes, feRes, viewResult, checklist] =
        await Promise.all([
          cached(
            `${root}::fingerprint`,
            await watchFilesFor(root, [
              join(root, 'app'),
              join(root, 'composer.json'),
              join(root, 'artisan'),
            ]),
            () => buildFingerprint(root, opts).catch(() => null),
          ),
          scanMigrations(join(root, 'database', 'migrations')),
          loadRoutesSafe(root, opts),
          cached(
            `${root}::frontend`,
            await watchFilesFor(root, [
              join(root, 'resources', 'views'),
              join(root, 'public', 'js'),
              join(root, 'resources', 'js'),
            ]),
            () => scanFrontend(root),
          ),
          buildViewGraph(join(root, 'resources', 'views')),
          Promise.resolve(checklistFor(params.featureType)),
        ]);
      const fingerprint = fpRes?.value ?? null;
      const frontend = feRes?.value ?? null;
      const routesList = routes;
      const domHtml = await collectAllViewContent(viewResult);
      const contractMap = buildContractMap({
        routes: routesList,
        frontend,
        domHtml,
      });

      // code graph (CBM) — CHỈ dùng project đã index sẵn, không bao giờ auto-index trong plan
      const graphFacts = await maybeGraphFacts(root, opts);

      const facts = {
        fingerprint: fingerprint
          ? renderFingerprint(fingerprint)
          : '(không đọc được fingerprint)',
        schema: renderSchema(schema),
        routes: `Có ${routesList.length} routes (${routesList.length ? '' : 'fallback parse web/api'}).`,
        frontend: frontend
          ? `views: ${frontend.views.length} · js files: ${frontend.files.filter((f) => f.kind === 'js-file').length} · csrf: ${frontend.csrfSetup ? '✓' : '✗'}`
          : '(không scan được frontend)',
        contracts: renderContractMap(contractMap),
        architecture:
          graphFacts ||
          '(code graph không khả dụng — dùng schema/routes/contracts thay thế)',
        checklist: renderChecklist(params.featureType),
      };

      // ── ② Prompt critics (3 song song) ──
      const summary = await sessionSummary(ctx);
      const critics = await runPromptCritics(
        { prompt: goal, sessionSummary: summary, repoHints: facts.fingerprint },
        { models, modelCfg, signal },
      );
      let requirementsText = '';
      if (critics.ok) {
        requirementsToGaps(registry, critics.merged, [
          'đối chiếu session + repo hints',
        ]);
        requirementsText = renderRequirementsMap(critics.merged);
      } else {
        registry.add({
          type: 'intent',
          what: `Critics lỗi: ${critics.error}`,
          evidenceSearched: [],
          priority: 'advisory',
        });
      }

      // ── ③ Clarification gate — intent gaps blocking → hỏi user ──
      const intentGaps = registry
        .open('intent')
        .filter((g) => g.priority === 'blocking');
      if (intentGaps.length && !params.skipQuestions) {
        const questions = gapsToQuestions(intentGaps, { max: 5 });
        return {
          content: [
            {
              type: 'text',
              text:
                `❓ Cần làm rõ trước khi lập kế hoạch (đã tìm trong session + repo, không có câu trả lời):\n${questions.join('\n')}\n\n` +
                `Trả lời xong gọi lại laravel_plan với context = câu trả lời (hoặc skipQuestions=true để đi tiếp với assumptions khai báo).`,
            },
          ],
        };
      }

      // ── ④ Explorer — đọc có mục tiêu từ mentions trong requirements ──
      const seedHints = [
        ...(critics.ok ? critics.merged.sessionFacts || [] : []),
        params.context || '',
      ].join(' · ');
      const focusFiles = extractFileMentions(seedHints, root);
      const exp = await explore(
        { root, goal, focusFiles, seedHints },
        { models, modelCfg, signal, budget: exploreBudget },
      );
      for (const f of exp.facts) {
        for (const fact of f.facts)
          umap.add(`${f.file}::${fact}`, `code:${f.file}`);
      }

      // ── ⑤ 5 planners + hội đồng ──
      const planning = await runPlanners(
        {
          goal,
          context: `${params.context || ''}\n\nREQUIREMENTS:\n${requirementsText}\n\nEXPLORER FACTS:\n${renderExplorerFacts(exp)}`,
          facts,
          featureType: params.featureType || '',
        },
        { models, modelCfg, signal },
      );
      if (!planning.ok) {
        return {
          content: [{ type: 'text', text: `Planners lỗi: ${planning.error}` }],
        };
      }
      let plan = planning.merged;

      // ── ⑥+⑦ Critic + gate loop ──
      const checklistIds = checklist.touchpoints || [];
      let criticReport = null;
      for (let round = 1; round <= maxRounds; round++) {
        const cd = await diffFromFiles(root, {
          bladeFiles: plan.touchpoints
            .filter((t) => t.item === 'view' || t.item === 'js')
            .map((t) => t.file)
            .filter(Boolean),
          jsFiles: [],
          requestFiles: plan.touchpoints
            .filter((t) => t.item === 'validation')
            .map((t) => t.file)
            .filter(Boolean),
          controllerFiles: plan.touchpoints
            .filter((t) => t.item === 'controller')
            .map((t) => t.file)
            .filter(Boolean),
        });
        const c = await critic(
          { root, plan, checklistIds, contractDiffResult: cd, goal },
          { models, modelCfg, signal },
        );
        criticReport = c;
        if (c.ok || round === maxRounds) break;

        // targeted re-explore: chỉ phần blocking
        const focus = c.blocking
          .filter((b) => b.check === 'claim' || b.check === 'hallucination')
          .map((b) => b.detail.match(/[A-Za-z_][\w\\/.-]*\.php/)?.[0])
          .filter(Boolean);
        const exp2 = await explore(
          { root, goal, focusFiles: focus, seedHints: c.report },
          { models, modelCfg, signal, budget: Math.min(10, exploreBudget) },
        );
        const focused = await runPlanners(
          {
            goal,
            context: `VÒNG ${round}: critic báo blocking:\n${c.report}\n\nDỮ LIỆU BỔ SUNG:\n${renderExplorerFacts(exp2)}`,
            facts,
            featureType: params.featureType || '',
          },
          // vòng re-plan chỉ cần lens Risk — rẻ hơn, tập trung chỗ critic chỉ ra
          { models, modelCfg, signal, roleKeys: ['risk'] },
        );
        if (focused.ok) plan = focused.merged;
      }

      // ── ⑧ Học + report ──
      await addEpisode(root, {
        task: goal.slice(0, 200),
        intent: critics.ok ? critics.merged.intent : 'unknown',
        filesRead: exp.readFiles,
        planFiles: plan.files,
        score: criticReport?.score,
        blockingCount: criticReport?.blocking?.length,
      }).catch(() => {});

      const lines = [
        `📋 PLAN (${plan.planCount || 1} planner · score ${criticReport?.score ?? '?'}) — repo: ${root}`,
        '',
        renderMergedPlan(plan),
        '',
        '── REQUIREMENTS ──',
        requirementsText || '(critics không chạy được)',
        '',
        criticReport?.report || '',
      ];

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};

/** Trích đường dẫn file tương đối từ text (cho explorer seed). */
export function extractFileMentions(text, _root) {
  const out = [];
  const re =
    /(?:app|routes|resources|database|tests|public)\/[\w/.-]+\.(?:php|blade\.php|js|css)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[0]);
  return [...new Set(out)].slice(0, 10);
}

/**
 * Code graph facts — CHỈ dùng khi CBM có sẵn VÀ project đã index.
 * Không bao giờ auto-index / auto-install trong plan (chậm + phụ thuộc binary).
 * Lỗi/missing → trả '' (degrade im lặng, plan vẫn chạy).
 */
async function maybeGraphFacts(root, opts) {
  try {
    const { cbm } = await import('../lib/cbm.js');
    const { realpath } = await import('node:fs/promises');
    const listed = await cbm('list_projects', {}, { ...opts, timeoutMs: 8000 });
    const projects = Array.isArray(listed?.projects) ? listed.projects : [];
    if (!projects.length) return '';
    const rootReal = await realpath(root).catch(() => root);
    let project = null;
    for (const p of projects) {
      const pr = p?.root_path
        ? await realpath(p.root_path).catch(() => p.root_path)
        : null;
      if (pr === rootReal) {
        project = p.name;
        break;
      }
    }
    if (!project) return '';
    const arch = await cbm(
      'get_architecture',
      { project, aspects: 'overview' },
      { ...opts, timeoutMs: 8000 },
    );
    return JSON.stringify(arch).slice(0, 2500);
  } catch {
    return '';
  }
}
