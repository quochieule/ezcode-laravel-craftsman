/**
 * laravel_plan — ★ tool chính: pipeline đầy đủ (đặc tả §4), CHẠY NỀN (hướng (a)).
 *
 * Thay đổi lớn v0.3: execute() trả về NGAY — pipeline (critics → explore →
 * planners → critic → re-plan) chạy ở background sau khi turn kết thúc:
 *   - Tiến trình publish lên panel qua background manager (`publishToSession`)
 *   - Kết quả đưa lại agent qua `sendUserMessage(..., {deliverAs:'followUp'})`
 *   - Guard 1 task/session — agent gọi lại lúc đang chạy sẽ nhận thông báo chờ
 *   - Hủy: panel Craftsman (Cancel) hoặc tự hủy khi session đóng
 *
 * Lý do: pipeline mất 30–120s+ chạy đồng bộ trong tool call → chặn cứng turn
 * (user không gõ được prompt, message bị queue/reject — lỗi "Agent is already
 * processing"). Chạy nền: turn rảnh ngay, user làm việc khác song song.
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
    '→ plan kèm score + unknowns. CHẠY NỀN: tool trả về ngay, kết quả được gửi vào hội thoại khi xong ' +
    '(tiến trình xem trên panel Craftsman). Gọi TRƯỚC khi sửa code cho feature chạm nhiều tầng. ' +
    'Pipeline chạy 30–120s ở nền — không chặn turn, KHÔNG gọi lại tới khi nhận kết quả.',
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
    'laravel_plan(goal, featureType?) — plan full-chain CHẠY NỀN, kết quả tới qua message',
  promptGuidelines: [
    'BẮT BUỘC gọi laravel_plan trước khi sửa code cho feature chạm nhiều tầng (route+controller+view+JS).',
    'laravel_plan trả về NGAY — kết quả tới sau qua message followUp. KHÔNG gọi lại cho tới khi nhận kết quả.',
    'Khi kết quả tới (plan/câu hỏi/lỗi) → xử lý theo nội dung: hỏi user nếu cần làm rõ rồi gọi LẠI với context, hoặc thực thi plan.',
    'Chỗ nào plan ghi unknowns/assumptions → phải kiểm tra trước khi làm tới đó.',
  ],

  async execute(_id, params, _signal, _onUpdate, ctx) {
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

    const background = ctx.background;
    if (!background) {
      return {
        content: [
          {
            type: 'text',
            text: 'Lỗi nội bộ: background manager không khả dụng (extension chưa được nạp đúng runtime). Thử reload extension.',
          },
        ],
      };
    }

    // ── Đăng ký task nền (guard: 1 task/session) ──
    const sessionId = ctx?.sessionManager?.getSessionId?.() || null;
    const started = background.start(sessionId, root, {
      kind: 'plan',
      stage: 'khởi động',
    });
    if (!started.ok) {
      return {
        content: [{ type: 'text', text: started.reason }],
        details: { background: true },
      };
    }
    const { taskId, task } = started;

    // Pipeline chạy nền — KHÔNG await (turn trả về ngay)
    runPlanPipeline({ params, ctx, root, cfg, modelCfg, sessionId, taskId, task })
      .catch((e) => {
        // Lỗi ngoài try/catch trong pipeline — vẫn báo về agent
        const msg = `[Craftsman] Plan task ${taskId.slice(0, 8)} lỗi ngoài dự kiến: ${e?.message || e}`;
        try {
          background.deliver(taskId, msg);
        } catch {
          /* task có thể đã bị hủy */
        }
        background.finish(taskId, 'error', { stage: 'error' });
      });

    return {
      content: [
        {
          type: 'text',
          text:
            `⏳ Plan đang chạy NỀN (task ${taskId.slice(0, 8)}) — agent rảnh ngay, ` +
            `user có thể làm việc khác song song.\n` +
            `- Tiến trình: panel Craftsman (triage/plan status).\n` +
            `- Khi xong: kết quả (plan / câu hỏi cần làm rõ / lỗi) sẽ được gửi vào hội thoại.\n` +
            `- Hủy: nút Cancel trên panel Craftsman.\n` +
            `KHÔNG gọi laravel_plan lại cho tới khi nhận được kết quả (guard 1 task/session).`,
        },
      ],
      details: { background: true, taskId },
    };
  },
};

/**
 * Pipeline đầy đủ chạy ở background.
 * Các stage vẫn tuần tự (data dependency) nhưng KHÔNG chặn turn; mỗi stage
 * cập nhật progress lên panel; signal = signal RIÊNG của task (không phải
 * signal của turn — turn đã kết thúc).
 */
async function runPlanPipeline({ params, ctx, root, cfg, modelCfg, sessionId, taskId, task }) {
  const background = ctx.background;
  const signal = task.signal; // AbortController của task — không dùng signal turn
  const update = (stage, progress) =>
    background.update(taskId, { stage, progress });

  const opts = settingsOpts(ctx);
  const models = ctx.createModelsCollection();
  const maxRounds = Number(cfg.plan_rounds ?? 3);
  const exploreBudget = Number(cfg.explore_budget ?? 30);
  const registry = new GapRegistry();
  const umap = new UnderstandingMap();

  try {
    // ── Gather facts (cache theo mtime — cached() trả {value, cached}, phải unwrap) ──
    update('scan codebase', 0.05);
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
    if (signal.aborted) return;
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
    update('3 critics phản biện prompt', 0.15);
    const summary = await sessionSummary(ctx);
    const critics = await runPromptCritics(
      { prompt: params.goal, sessionSummary: summary, repoHints: facts.fingerprint },
      { models, modelCfg, signal },
    );
    if (signal.aborted) return;
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

    // ── ③ Clarification gate — intent gaps blocking → hỏi user (qua message) ──
    const intentGaps = registry
      .open('intent')
      .filter((g) => g.priority === 'blocking');
    if (intentGaps.length && !params.skipQuestions) {
      const questions = gapsToQuestions(intentGaps, { max: 5 });
      const text =
        `[Craftsman] Plan task ${taskId.slice(0, 8)} cần làm rõ trước khi lập kế hoạch ` +
        `(đã tìm trong session + repo, không có câu trả lời):\n${questions.join('\n')}\n\n` +
        `Hãy hỏi user các câu trên, rồi gọi LẠI laravel_plan với context = câu trả lời ` +
        `(hoặc skipQuestions=true để đi tiếp với assumptions khai báo).`;
      background.update(taskId, { stage: 'cần user trả lời', progress: 0.2 });
      background.deliver(taskId, text);
      background.finish(taskId, 'awaiting', { stage: 'cần user trả lời' });
      return;
    }

    // ── ④ Explorer — đọc có mục tiêu từ mentions trong requirements ──
    update('explorer đọc code', 0.25);
    const seedHints = [
      ...(critics.ok ? critics.merged.sessionFacts || [] : []),
      params.context || '',
    ].join(' · ');
    const focusFiles = extractFileMentions(seedHints, root);
    const exp = await explore(
      { root, goal: params.goal, focusFiles, seedHints },
      { models, modelCfg, signal, budget: exploreBudget },
    );
    if (signal.aborted) return;
    for (const f of exp.facts) {
      for (const fact of f.facts)
        umap.add(`${f.file}::${fact}`, `code:${f.file}`);
    }

    // ── ⑤ 5 planners + hội đồng ──
    update('5 planners song song', 0.5);
    const planning = await runPlanners(
      {
        goal: params.goal,
        context: `${params.context || ''}\n\nREQUIREMENTS:\n${requirementsText}\n\nEXPLORER FACTS:\n${renderExplorerFacts(exp)}`,
        facts,
        featureType: params.featureType || '',
      },
      { models, modelCfg, signal },
    );
    if (signal.aborted) return;
    if (!planning.ok) {
      const text = `[Craftsman] Plan task ${taskId.slice(0, 8)} lỗi: ${planning.error}`;
      background.deliver(taskId, text);
      background.finish(taskId, 'error', { stage: 'planners lỗi' });
      return;
    }
    let plan = planning.merged;

    // ── ⑥+⑦ Critic + gate loop ──
    update('critic phản biện plan', 0.7);
    const checklistIds = checklist.touchpoints || [];
    let criticReport = null;
    for (let round = 1; round <= maxRounds; round++) {
      if (signal.aborted) return;
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
        { root, plan, checklistIds, contractDiffResult: cd, goal: params.goal },
        { models, modelCfg, signal },
      );
      criticReport = c;
      if (c.ok || round === maxRounds) break;

      // targeted re-explore: chỉ phần blocking
      update(`re-plan vòng ${round}`, 0.7 + 0.08 * round);
      const focus = c.blocking
        .filter((b) => b.check === 'claim' || b.check === 'hallucination')
        .map((b) => b.detail.match(/[A-Za-z_][\w\\/.-]*\.php/)?.[0])
        .filter(Boolean);
      const exp2 = await explore(
        { root, goal: params.goal, focusFiles: focus, seedHints: c.report },
        { models, modelCfg, signal, budget: Math.min(10, exploreBudget) },
      );
      if (signal.aborted) return;
      const focused = await runPlanners(
        {
          goal: params.goal,
          context: `VÒNG ${round}: critic báo blocking:\n${c.report}\n\nDỮ LIỆU BỔ SUNG:\n${renderExplorerFacts(exp2)}`,
          facts,
          featureType: params.featureType || '',
        },
        // vòng re-plan chỉ cần lens Risk — rẻ hơn, tập trung chỗ critic chỉ ra
        { models, modelCfg, signal, roleKeys: ['risk'] },
      );
      if (signal.aborted) return;
      if (focused.ok) plan = focused.merged;
    }

    // ── ⑧ Học + deliver kết quả về agent ──
    update('chốt plan', 0.95);
    await addEpisode(root, {
      task: params.goal.slice(0, 200),
      intent: critics.ok ? critics.merged.intent : 'unknown',
      filesRead: exp.readFiles,
      planFiles: plan.files,
      score: criticReport?.score,
      blockingCount: criticReport?.blocking?.length,
    }).catch(() => {});

    const lines = [
      `[Craftsman] PLAN XONG (task ${taskId.slice(0, 8)}) — thực thi theo plan dưới đây.`,
      '',
      `📋 PLAN (${plan.planCount || 1} planner · score ${criticReport?.score ?? '?'}) — repo: ${root}`,
      '',
      renderMergedPlan(plan),
      '',
      '── REQUIREMENTS ──',
      requirementsText || '(critics không chạy được)',
      '',
      criticReport?.report || '',
    ];

    const text = lines.join('\n');
    background.deliver(taskId, text);
    background.finish(taskId, 'done', { stage: 'xong', progress: 1 });
  } catch (e) {
    const text = `[Craftsman] Plan task ${taskId.slice(0, 8)} lỗi: ${e.message}`;
    background.deliver(taskId, text);
    background.finish(taskId, 'error', { stage: 'error' });
  }
}

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
