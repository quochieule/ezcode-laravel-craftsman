/**
 * prompt-critics.js — Stage ②: 3 subagent SONG SONG phản biện prompt (đặc tả §4-②).
 *
 * A "Người đọc yêu cầu" — user muốn gì, ràng buộc gì
 * B "Kẻ ngờ vực"      — mơ hồ/thiếu/giả định
 * C "Người đối chiếu" — session + codebase có gì liên quan
 *
 * Output cùng schema → hội đồng merge → Requirements Map.
 * Mỗi critic = 1 context riêng; chỉ artifact đi qua biên giới.
 */
import { callModel, extractJson } from '../llm.js';

const CRITIC_SCHEMA_HINT =
  'Trả JSON thuần theo schema: ' +
  '{"intent":"feature|bugfix|question|reverify|refactor|optimize|trivial",' +
  '"scope":"backend|frontend|both|unclear",' +
  '"explicit":["điều user nói RÕ, mỗi item 1 câu"],' +
  '"ambiguous":["điều MƠ HỒ cần làm rõ"],' +
  '"missing":["điều THIẾU mà phải biết để làm đúng"],' +
  '"assumptions":["giả định đang bị đặt mà chưa xác minh"],' +
  '"sessionFacts":["sự thật lấy từ session (nếu có)"]}';

function criticSystem(role) {
  return (
    `Bạn là ${role} trong pipeline lập kế hoạch cho coding agent Laravel. ` +
    'Nhiệm vụ: phân tích prompt của user để tạo Requirements Map. ' +
    'NGHIÊM CẤM bịa thông tin — mọi claim phải xuất phát từ prompt/session/data được cung cấp. ' +
    CRITIC_SCHEMA_HINT
  );
}

const ROLES = {
  reader:
    'Người đọc yêu cầu — diễn giải chính xác user muốn gì, phạm vi, ràng buộc; không thêm, không bớt',
  devil:
    'Kẻ ngờ vực — nhiệm vụ là tìm MƠ HỒ, THIẾU, và giả định nguy hiểm; prompt sơ sài thì phải chỉ ra hết',
  matcher:
    'Người đối chiếu — đối chiếu prompt với SESSION và CODEBASE đã cho; phát hiện mâu thuẫn, việc đang dở, điều đã chốt từ trước',
};

/**
 * Chạy 3 critics song song.
 * @param {object} input { prompt, sessionSummary, repoHints }
 * @param {object} deps { models, modelCfg, signal, runner? }
 * @returns {Promise<{ok:boolean, results:Array, merged:object, error?:string}>}
 *   merged: { intent, scope, explicit[], ambiguous[], missing[], assumptions[], sessionFacts[], disagreement:boolean }
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

  const results = await Promise.all(
    Object.entries(ROLES).map(async ([key, role]) => {
      const res = await run(criticSystem(role), base);
      return { key, role, ...res };
    }),
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    return {
      ok: false,
      results,
      merged: null,
      error: failed.map((f) => `${f.key}: ${f.error}`).join(' · '),
    };
  }

  const jsons = results.map((r) => r.json || {});
  const merged = mergeCritics(jsons);
  return { ok: true, results, merged };
}

/** Hội đồng 0: hợp nhất 3 critics — union có dedup, intent/scope theo đa số. */
export function mergeCritics(jsons) {
  const union = (key) => {
    const set = new Set();
    for (const j of jsons)
      for (const x of j?.[key] || [])
        if (String(x).trim()) set.add(String(x).trim());
    return [...set];
  };
  const votes = (key) => {
    const count = {};
    for (const j of jsons) {
      const v = j?.[key];
      if (v) count[v] = (count[v] || 0) + 1;
    }
    const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  };

  const intent = votes('intent');
  const scope = votes('scope');
  // bất đồng = 3 critic không cùng intent (đa số chỉ 1/3)
  const intentVotes = jsons.map((j) => j?.intent).filter(Boolean);
  const disagreement = new Set(intentVotes).size > 1;

  return {
    intent,
    scope,
    explicit: union('explicit'),
    ambiguous: union('ambiguous'),
    missing: union('missing'),
    assumptions: union('assumptions'),
    sessionFacts: union('sessionFacts'),
    disagreement,
    criticCount: jsons.length,
  };
}

/** Render Requirements Map gọn. */
export function renderRequirementsMap(m) {
  const lines = [];
  if (m.intent)
    lines.push(
      `Intent: ${m.intent} · Scope: ${m.scope || 'unclear'}${m.disagreement ? ' ⚠️ (các critic bất đồng — xử lý phủ cả 2)' : ''}`,
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

export { extractJson };
