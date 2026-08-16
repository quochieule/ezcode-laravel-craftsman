/**
 * prompt-critics.js — Stage ②: 1 critic phản biện prompt (gộp 3 vai).
 *
 * v0.6 — theo yêu cầu user: "tất cả chỉ chạy 1 lần, không cần chạy nhiều sau đó
 * gộp lại". Bỏ hội đồng N critic + mergeCritics. Một prompt GỘP 3 góc nhìn
 * (người đọc yêu cầu · kẻ ngờ vực · người đối chiếu) → 1 call, trả Requirements
 * Map. Đo thật: 3 critic song song ≈ 1 critic về wall-clock (7.8s vs 10.8s) nên
 * không mất thời gian, tiết kiệm 3× token.
 *
 * Output schema giữ nguyên → Requirements Map.
 */
import { callModel } from '../llm.js';

const CRITIC_SCHEMA_HINT =
  'Trả JSON thuần theo schema: ' +
  '{"intent":"feature|bugfix|question|reverify|refactor|optimize|trivial",' +
  '"scope":"backend|frontend|both|unclear",' +
  '"explicit":["điều user nói RÕ, mỗi item 1 câu"],' +
  '"ambiguous":["điều MƠ HỒ cần làm rõ"],' +
  '"missing":["điều THIẾU mà phải biết để làm đúng"],' +
  '"assumptions":["giả định đang bị đặt mà chưa xác minh"],' +
  '"sessionFacts":["sự thật lấy từ session (nếu có)"]}';

/** Prompt gộp 3 vai — 1 call, đủ 3 góc nhìn. */
export const CRITIC_SYSTEM =
  'Bạn là nhóm 3 chuyên gia GỘP LÀM MỘT trong pipeline lập kế hoạch cho coding agent Laravel:\n' +
  '1) Người đọc yêu cầu — diễn giải chính xác user muốn gì, phạm vi, ràng buộc; không thêm, không bớt\n' +
  '2) Kẻ ngờ vực — nhiệm vụ là tìm MƠ HỒ, THIẾU, và giả định nguy hiểm; prompt sơ sài thì phải chỉ ra hết\n' +
  '3) Người đối chiếu — đối chiếu prompt với SESSION và CODEBASE đã cho; phát hiện mâu thuẫn, việc đang dở, điều đã chốt từ trước\n' +
  'Điền ĐẦY ĐỦ mọi field của schema từ góc nhìn cả 3 vai. ' +
  'NGHIÊM CẤM bịa thông tin — mọi claim phải xuất phát từ prompt/session/data được cung cấp. ' +
  CRITIC_SCHEMA_HINT;

/**
 * Chạy 1 critic (gộp 3 vai).
 * @param {object} input { prompt, sessionSummary, repoHints }
 * @param {object} deps { models, modelCfg, signal, runner? }
 * @returns {Promise<{ok:boolean, results:Array, merged:object, error?:string}>}
 *   merged: { intent, scope, explicit[], ambiguous[], missing[], assumptions[], sessionFacts[] }
 */
export async function runPromptCritics(
  { prompt, sessionSummary = '', repoHints = '' },
  deps,
) {
  const { models, modelCfg, signal, runner } = deps;
  const run =
    runner ||
    ((sys, user) =>
      callModel(models, modelCfg, {
        systemPrompt: sys,
        userPrompt: user,
        jsonMode: true,
        signal,
      }));

  const base = [
    `PROMPT CỦA USER:\n${String(prompt).slice(0, 3000)}`,
    sessionSummary
      ? `TÓM TẮT SESSION (những gì đã nói trước đó):\n${sessionSummary.slice(0, 2500)}`
      : '(không có session context)',
    repoHints
      ? `THÔNG TIN REPO (fingerprint tóm tắt):\n${repoHints.slice(0, 1500)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await run(CRITIC_SYSTEM, base);
  if (!res.ok) {
    return { ok: false, results: [res], merged: null, error: res.error };
  }
  return {
    ok: true,
    results: [{ key: 'combined', role: 'Nhóm 3 vai gộp', ...res }],
    merged: res.json,
  };
}

/** Render Requirements Map gọn. */
export function renderRequirementsMap(m) {
  const lines = [];
  if (m.intent)
    lines.push(
      `Intent: ${m.intent} · Scope: ${m.scope || 'unclear'}`,
    );
  if (m.explicit?.length) lines.push(`Rõ: ${m.explicit.join(' · ')}`);
  if (m.ambiguous?.length) lines.push(`🟡 Mơ hồ: ${m.ambiguous.join(' · ')}`);
  if (m.missing?.length) lines.push(`❓ Thiếu: ${m.missing.join(' · ')}`);
  if (m.assumptions?.length)
    lines.push(`⚠️ Giả định: ${m.assumptions.join(' · ')}`);
  if (m.sessionFacts?.length)
    lines.push(`Session: ${m.sessionFacts.join(' · ')}`);
  return lines.join('\n') || '(requirements map rỗng)';
}

/** Chuyển requirements map → gap registry (chỉ mơ hồ/thiếu → gap). */
export function requirementsToGaps(
  registry,
  merged,
  evidenceSearched = ['đối chiếu session + repo hints'],
) {
  for (const a of merged.ambiguous || []) {
    registry.add({
      type: 'intent',
      what: `Mơ hồ: ${a}`,
      evidenceSearched,
      priority: 'blocking',
    });
  }
  for (const m of merged.missing || []) {
    registry.add({
      type: 'intent',
      what: `Thiếu: ${m}`,
      evidenceSearched,
      priority: 'blocking',
    });
  }
  for (const a of merged.assumptions || []) {
    registry.add({
      type: 'intent',
      what: `Giả định: ${a}`,
      evidenceSearched,
      priority: 'advisory',
    });
  }
  return registry;
}
