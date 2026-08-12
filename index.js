import fingerprintTool from './tools/laravel-fingerprint.js';
import schemaTool from './tools/laravel-schema.js';
import contractsTool from './tools/laravel-contracts.js';
import planTool from './tools/laravel-plan.js';
import reverifyTool from './tools/laravel-reverify.js';
import auditTool from './tools/laravel-audit.js';
import traceFlowTool from './tools/laravel-trace-flow.js';

/**
 * Laravel Craftsman — senior code intelligence cho Laravel + Blade + jQuery/Ajax.
 *
 * v0.2 — đầy đủ pipeline (M0–M8 cơ bản):
 *   - 7 tools: fingerprint / schema / contracts / plan (pipeline đầy đủ) /
 *     reverify (RVP 3 kênh) / audit (dead code 3 mức) / trace_flow
 *   - input event: TRIAGE tự động mọi prompt → transform ép đúng pipeline
 *   - tool_call gate: strict mode — chặn edit khi chưa explore/plan
 *   - agent_end: auto-RVP gọn + lưu episode (learning)
 *   - panel: dashboard Understanding Map + gaps + episodes
 *
 * Tất cả theo đặc tả docs/LARAVEL-CRAFTSMAN.md trong folder này.
 */

// Tool mutating — bị gate kiểm soát khi strict_mode
const MUTATING_RE =
  /^(edit|write|patch|apply|multi_edit|create|replace|insert|delete)$/i;

export default function (pi) {
  const tools = [
    fingerprintTool,
    schemaTool,
    contractsTool,
    planTool,
    reverifyTool,
    auditTool,
    traceFlowTool,
  ];

  for (const tool of tools) {
    const originalExecute = tool.execute;
    pi.registerTool({
      ...tool,
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        originalExecute(toolCallId, params, signal, onUpdate, {
          ...ctx,
          extensionSettings: pi.settings.all(),
          createModelsCollection: pi.createModelsCollection,
        }),
    });
  }

  // ── State per-turn (module-shared lib/* — key theo session, không đụng nhau) ──
  const turnState = new Map(); // sessionId → { triaged, complex, planned }

  // ── Panel dashboard ──
  try {
    pi.setPanelSchema?.('laravel-craftsman', {
      schema: {
        type: 'object',
        properties: {
          lastTriage: { type: 'string', title: 'Triage gần nhất' },
          lastPlanScore: { type: 'string', title: 'Plan score' },
          episodes: {
            type: 'array',
            title: 'Episodes gần nhất',
            items: { type: 'object' },
          },
          gaps: { type: 'array', title: 'Gaps mở', items: { type: 'object' } },
        },
      },
      tabLabel: 'Craftsman',
      icon: 'hammer',
      onAction: async ({ action, cwd, sessionId }) => {
        if (action === 'status') {
          const { recentEpisodes } = await import('./lib/memory.js');
          const episodes = cwd
            ? await recentEpisodes(cwd, 5).catch(() => [])
            : [];
          return {
            ok: true,
            lastTriage: turnState.get(sessionId)?.triaged ? '✓' : '—',
            episodes,
          };
        }
        return { ok: false, error: `action không hỗ trợ: ${action}` };
      },
    });
  } catch {
    /* probe stub có thể thiếu setPanelSchema — bỏ qua */
  }

  const publish = (sessionId, data) => {
    try {
      pi.publishToSession?.(sessionId, 'laravel-craftsman', data);
    } catch {
      /* không có panel runtime */
    }
  };

  // ── ① TRIAGE mọi prompt (input event) ──
  pi.on('input', async (event, ctx) => {
    const cfg = pi.settings?.all?.() ?? {};
    const text = event?.text || '';
    if (!text.trim() || text.includes('[Craftsman]')) return undefined; // prompt do chính mình transform — không lặp

    const sessionId = ctx?.sessionId;
    const { triage, transformForIntent } =
      await import('./lib/stages/triage.js');

    // heuristic luôn chạy (0 chi phí); LLM refine chỉ khi có model_triage
    let result;
    try {
      result = await triage(text, {
        models: cfg.model_triage ? pi.createModelsCollection() : null,
        modelCfg: cfg.model_triage,
        signal: undefined,
      });
    } catch {
      result = { intent: 'trivial', scope: 'unclear', level: 'trivial' };
    }

    const state = { triaged: result, at: Date.now() };
    turnState.set(sessionId, state);
    publish(sessionId, {
      lastTriage: `${result.intent}/${result.scope}/${result.level}`,
    });

    // question → answer-mode transform (trả lời có evidence)
    if (result.intent === 'trivial') return undefined;

    const transformed = transformForIntent(result);
    if (transformed) return transformed;
    return undefined;
  });

  // ── Gate: chặn edit khi chưa plan/explore (strict mode) ──
  pi.on('tool_call', async (event, ctx) => {
    const cfg = pi.settings?.all?.() ?? {};
    if (!(cfg.strict_mode === true || cfg.strict_mode === 'true'))
      return undefined;

    const toolName = event?.toolName || event?.name || '';
    const isPlanning = /^laravel_/.test(toolName);
    const sessionId = ctx?.sessionId;
    const state = turnState.get(sessionId);

    if (isPlanning && state) {
      state.planned = true;
      return undefined;
    }

    if (!MUTATING_RE.test(toolName)) return undefined;

    // Chặn khi: lượt này triaged là complex feature/bugfix NHƯNG chưa gọi tool laravel_* nào
    if (state && !state.planned) {
      const triaged = state.triaged || {};
      const needsPlan = ['feature', 'bugfix', 'refactor', 'optimize'].includes(
        triaged.intent,
      );
      if (needsPlan) {
        return {
          block: true,
          reason:
            `[Craftsman] Yêu cầu này được triage là ${triaged.intent}/${triaged.scope} — phải explore trước khi sửa. ` +
            `Gọi laravel_plan (feature) hoặc laravel_contracts/laravel_trace_flow (bugfix) trước, ` +
            `hoặc tắt strict_mode trong Settings → Laravel Craftsman nếu muốn sửa trực tiếp.`,
        };
      }
    }
    return undefined;
  });

  // ── session_shutdown: dọn state per-session (tránh leak) ──
  pi.on('session_shutdown', (event, ctx) => {
    turnState.delete(ctx?.sessionId);
    return undefined;
  });

  // ── agent_end: auto-RVP gọn + learning ──
  pi.on('agent_end', async (_event, ctx) => {
    const cfg = pi.settings?.all?.() ?? {};
    const cwd = ctx?.cwd;
    if (!cwd) return undefined;

    // learning: chỉ lưu episode cho turn không-trivial (tránh nhiễu)
    const state = turnState.get(ctx?.sessionId);
    if (
      state?.triaged &&
      ['trivial', 'question'].includes(state.triaged.intent)
    ) {
      return undefined;
    }
    const { addEpisode } = await import('./lib/memory.js');
    await addEpisode(cwd, {
      task: '(agent turn)',
      intent: state?.triaged?.intent || 'agent',
      filesRead: [],
      planFiles: [],
    }).catch(() => {});

    const autoRvp =
      cfg.auto_rvp === true ||
      cfg.auto_rvp === 'true' ||
      cfg.auto_rvp === undefined;
    if (!autoRvp) return undefined;

    // RVP gọn: deterministic + 1 verifier (nếu có model) — không chạy test nặng
    const { runRvp } = await import('./lib/stages/rvp.js');
    const { resolveRepoRoot, isLaravelRepo } = await import('./lib/context.js');
    const root = await resolveRepoRoot(cwd);
    if (!root || !(await isLaravelRepo(root))) return undefined;

    // reality: lấy file đã sửa từ git diff — RVP kiểm tra ĐÚNG thứ vừa đụng
    const { execFile } = await import('node:child_process');
    const gitFiles = await new Promise((resolve) => {
      execFile(
        'git',
        ['diff', '--name-only', 'HEAD'],
        {
          cwd: root,
          timeout: 10000,
          maxBuffer: 5 * 1024 * 1024,
          windowsHide: true,
        },
        (e, stdout) =>
          resolve(e ? [] : String(stdout).split('\n').filter(Boolean)),
      );
    });
    if (!gitFiles.length) return undefined; // không có thay đổi → không cần verify

    const result = await runRvp(
      {
        root,
        goal: '(auto verify sau task)',
        plan: {
          files: gitFiles.filter((f) => /\.(php|js|blade\.php)$/.test(f)),
          touchpoints: gitFiles.map((f) => ({
            item: 'modified',
            file: f,
            action: 'modify',
          })),
          tests: [],
          assumptions: [],
          unknowns: [],
        },
        checklistIds: [],
        diffText: '',
        runTests: false,
        exec: null,
      },
      {
        models: cfg.model_verifier ? pi.createModelsCollection() : null,
        modelCfg: cfg.model_verifier || cfg.model_planner,
        verifierCount: 1,
      },
    ).catch(() => null);

    if (result?.missing?.length) {
      try {
        pi.sendUserMessage?.(
          `[Craftsman auto-verify] Phát hiện ${result.missing.length} vấn đề sau lượt vừa rồi:\n` +
            result.missing.map((m) => `- ${m.item}: ${m.evidence}`).join('\n') +
            `\nHãy kiểm tra và sửa trước khi báo xong.`,
          { deliverAs: 'followUp' },
        );
      } catch {
        /* không đẩy được message — bỏ qua */
      }
    }
    return undefined;
  });
}
