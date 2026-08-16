import { createBackgroundManager } from './lib/background.js';
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
  // Background Task Manager — tool chạy lâu (laravel_plan) trả về ngay, pipeline
  // chạy nền; tiến trình publish lên panel, kết quả deliver qua followUp (hướng (a)).
  const background = createBackgroundManager(pi);

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
          background,
        }),
    });
  }

  // ── State per-turn (module-shared lib/* — key theo session, không đụng nhau) ──
  const turnState = new Map(); // sessionId → { triaged, complex, planned }

  // ── Panel dashboard ──
  // Schema theo chuẩn schemaRenderer (frontend/src/engine/schemaRenderer.js):
  // root + defs + node types (stack/inline/field/text/list/card). KHÔNG dùng
  // JSON-schema `{type:'object', properties}` — renderer không có node type
  // 'object' → panel sẽ hiện "Schema render error" (bug v0.2). State = payload
  // CUỐI CÙNG nhận được; mọi publish phải có key khớp field path (VD `plan.*`).
  try {
    pi.setPanelSchema?.('laravel-craftsman', {
      schema: {
        defs: {
          epRow: {
            type: 'stack',
            of: [
              {
                type: 'field',
                path: '__item.task',
                className: 'text-[11px] text-gray-600 dark:text-gray-300',
              },
              {
                type: 'inline',
                of: [
                  {
                    type: 'field',
                    path: '__item.intent',
                    className: 'text-[10px] text-gray-400 font-mono',
                  },
                  {
                    type: 'field',
                    path: '__item.missingCount',
                    className: 'text-[10px] text-amber-500 font-mono',
                  },
                ],
              },
            ],
          },
        },
        root: {
          type: 'stack',
          of: [
            {
              type: 'inline',
              of: [
                {
                  type: 'text',
                  content: 'Triage: ',
                  className: 'text-xs text-gray-400',
                },
                {
                  type: 'field',
                  path: 'lastTriage',
                  className: 'text-xs',
                },
              ],
            },
            // Plan nền (hướng a) — card chỉ hiện khi có task
            {
              type: 'card',
              when: { path: 'plan.id', exists: true },
              body: {
                type: 'stack',
                of: [
                  {
                    type: 'field',
                    path: 'plan.id',
                    className: 'text-[10px] font-mono text-gray-400',
                  },
                  {
                    type: 'inline',
                    of: [
                      {
                        type: 'text',
                        content: 'Status: ',
                        className: 'text-[11px] text-gray-400',
                      },
                      {
                        type: 'field',
                        path: 'plan.status',
                        className: 'text-[11px] font-semibold',
                      },
                      {
                        type: 'text',
                        content: ' · ',
                        className: 'text-[11px] text-gray-400',
                      },
                      {
                        type: 'field',
                        path: 'plan.stage',
                        className: 'text-[11px]',
                      },
                    ],
                  },
                ],
              },
            },
            {
              type: 'text',
              content: 'Episodes:',
              className: 'text-xs font-semibold mt-1',
            },
            {
              type: 'list',
              of: { path: 'episodes' },
              each: { component: 'epRow' },
            },
          ],
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
          const running = sessionId ? background.runningFor(sessionId) : null;
          return {
            ok: true,
            lastTriage: turnState.get(sessionId)?.triaged ? '✓' : '—',
            plan: running
              ? {
                  id: running.id,
                  kind: running.kind,
                  status: running.status,
                  stage: running.stage,
                  progress: running.progress,
                  startedAt: running.startedAt,
                }
              : null,
            episodes,
          };
        }
        if (action === 'cancelPlan') {
          const n = sessionId ? background.cancelBySession(sessionId) : 0;
          return {
            ok: true,
            canceled: n,
            message: n ? `Đã hủy ${n} task nền.` : 'Không có task nền nào đang chạy.',
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

    const sessionId = ctx?.sessionId;

    // Guard chống ping-pong auto-RVP: prompt do NGƯỜI DÙNG gửi reset cờ,
    // followUp do extension tự bơm (deliverAs:'followUp' → source:'extension')
    // KHÔNG reset — nếu không agent_end sẽ auto-verify chính turn verify của
    // mình mãi: verify → agent sửa file → agent_end → RVP → followUp → ...
    if (sessionId) {
      const st = turnState.get(sessionId);
      if (st && event?.source !== 'extension') st.autoRvpSent = false;
    }

    if (!text.trim() || text.includes('[Craftsman]')) return undefined; // prompt do chính mình transform — không lặp
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
    if (transformed) {
      // QUAN TRỌNG: transform chỉ THÊM chỉ thị quy trình — luôn giữ nguyên
      // yêu cầu gốc của user. Nếu chỉ trả text chỉ thị, agent không còn thấy
      // goal → từ chối làm việc (bug: "không có mục tiêu").
      // Intent dùng laravel_plan (feature/bugfix/refactor/optimize) → gắn nhãn
      // `goal` rõ ràng để model truyền NGUYÊN VĂN vào laravel_plan(goal=...).
      const goalHint =
        ['feature', 'bugfix', 'refactor', 'optimize'].includes(result.intent)
          ? 'goal (yêu cầu gốc của user — truyền NGUYÊN VĂN vào laravel_plan(goal=...)):'
          : 'Yêu cầu gốc của user:'; // reverify/question: không cần trích goal
      return {
        ...transformed,
        text: `${transformed.text}\n\n${goalHint}\n${text}`,
      };
    }
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

  // ── session_shutdown: dọn state per-session (tránh leak) + hủy task nền ──
  pi.on('session_shutdown', (event, ctx) => {
    turnState.delete(ctx?.sessionId);
    // Task nền bám vào pi/session đã chết — deliver sẽ vô nghĩa, hủy luôn
    // (panel cũng không còn ai xem).
    try {
      background.cancelBySession(ctx?.sessionId);
    } catch {
      /* bỏ qua */
    }
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

    if (result?.missing?.length && !state?.autoRvpSent) {
      // Chặn ping-pong: mỗi chuỗi turn từ 1 prompt người dùng chỉ auto-verify +
      // đẩy followUp 1 LẦN. Turn do chính followUp này khởi tạo (source:'extension')
      // không reset cờ ở input handler → nếu agent vẫn sửa file ở turn đó, agent_end
      // này sẽ skip, không sinh followUp thứ 2/3/... Cờ reset khi có prompt mới.
      if (state) state.autoRvpSent = true;
      else turnState.set(ctx?.sessionId, { autoRvpSent: true });
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
