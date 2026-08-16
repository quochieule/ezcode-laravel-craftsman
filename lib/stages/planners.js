/**
 * planners.js — Stage ⑤: 1 planner lập kế hoạch (không hội đồng, không merge).
 *
 * v0.6 — theo yêu cầu user: "tất cả chỉ chạy 1 lần, không cần chạy nhiều sau đó
 * gộp lại". Bỏ N planner song song + mergePlans. Mặc định 1 vai Kiến trúc sư
 * backend (phần chính); vòng re-plan dùng riêng vai Risk (tìm lỗi plan).
 *
 * Mỗi vai có thể chạy bằng 1 LLM call hoặc 1 sub-agent thật (use_subagents —
 * có tool read tự kiểm chứng file).
 */
import { callModel } from '../llm.js';

const PLAN_SCHEMA_HINT =
  'Trả JSON thuần theo schema: ' +
  '{"touchpoints":[{"item":"route","action":"existing|new|modify","file":"đường dẫn tương đối","reason":"1 dòng"}],' +
  '"files":["file sẽ đụng"],"tests":["test sẽ thêm/sửa"],"risks":["rủi ro ngắn"],' +
  '"assumptions":["giả định chưa xác minh"],"unknowns":["thứ chưa kiểm tra được với dữ liệu hiện có"]}';

/** System prompt theo vai — architect là "phần chính", risk dùng cho re-plan. */
export const PLANNER_SYSTEMS = {
  architect:
    'Bạn là kiến trúc sư Laravel kỳ cựu, nhìn TOP-DOWN. Nhiệm vụ: xác định module/layer nào bị đụng, ' +
    'thiết kế luồng chính, ai chịu trách nhiệm logic (controller mỏng? service?). Chỉ dùng dữ liệu được cấp. ' +
    'KHÔNG bịa file/package/API. ' +
    PLAN_SCHEMA_HINT,
  risk:
    'Bạn là QA + kỹ sư phản biện. NHIỆM VỤ CỦA BẠN LÀ TÌM LÝ DO KẾ HOẠCH SAI/THIẾU — không phải khen. ' +
    'Check: touchpoint nào bị sót, edge case nào vỡ, guard nào thiếu test, caller nào bị ảnh hưởng, dead-code risk. ' +
    'Mỗi risk phải kèm evidence (file/thứ đã thấy trong dữ liệu). ' +
    PLAN_SCHEMA_HINT,
};

/** Đóng gói evidence theo vai — pack riêng, token cap. */
export function packForRole(key, facts) {
  const packs = {
    // architect = "phần chính" — phải thấy ĐỦ tầng (kể cả frontend/contracts)
    // để plan không miss touchpoint view/js ngay từ vòng đầu (không chờ critic)
    architect: [
      'fingerprint',
      'architecture',
      'routes',
      'schema',
      'frontend',
      'contracts',
      'views',
      'sideEffects',
      'learned',
      'learnedChecks',
      'checklist',
    ]
      .map((k) => facts[k])
      .filter(Boolean),
    risk: ['contracts', 'schema', 'routes', 'checklist']
      .map((k) => facts[k])
      .filter(Boolean),
  };
  const joined = (packs[key] || []).join('\n\n').slice(0, 8000);
  return (
    joined || '(không có dữ liệu cho vai này — trả plan dựa trên checklist)'
  );
}

/**
 * Chạy 1 planner (1 lần — không merge).
 * @param {object} input { goal, context, facts { fingerprint, schema, routes, frontend, contracts, checklist }, featureType }
 * @param {object} deps { roleKey?: 'architect'|'risk', models, modelCfg, signal, runner?, subagent? }
 * @returns {Promise<{ok:boolean, results:Array, merged:object|null, error?:string}>}
 *   merged: plan JSON { touchpoints, files, tests, risks, assumptions, unknowns }
 */
export async function runPlanners(
  { goal, context = '', facts, featureType = '' },
  deps,
) {
  const { models, modelCfg, signal, runner } = deps;
  const roleKey = deps.roleKey || 'architect';
  const system = PLANNER_SYSTEMS[roleKey];
  if (!system) {
    return {
      ok: false,
      results: [],
      merged: null,
      error: `roleKey không hợp lệ: ${roleKey}`,
    };
  }
  const run =
    runner ||
    ((sys, user) =>
      callModel(models, modelCfg, {
        systemPrompt: sys,
        userPrompt: user,
        jsonMode: true,
        signal,
      }));

  const goalText = `YÊU CẦU:\n${String(goal).slice(0, 2000)}${context ? `\nNGỮ CẢNH:\n${context.slice(0, 1500)}` : ''}`;

  const userPrompt = [
    goalText,
    `LOẠI FEATURE: ${featureType || 'general'}`,
    `DỮ LIỆU THẬT (chỉ dùng cái này, không bịa):\n${packForRole(roleKey, facts)}`,
    `Giới hạn: tối đa 20 touchpoints.`,
  ].join('\n\n');

  let res;
  if (deps.subagent) {
    // Sub-agent thật: 1 AgentSession có tool read — tự kiểm chứng file trước
    // khi chốt touchpoint (hết hallucination file).
    res = await deps.subagent.run({
      role: roleKey,
      systemPrompt: system,
      mission:
        `${userPrompt}\n\nKIỂM CHỨNG: dùng tool read/ls/find/grep để xác minh ` +
        `file/touchpoint THẬT tồn tại trước khi chốt — không bịa file, không bịa method. ` +
        `Trả JSON thuần theo schema.`,
      modelCfg: deps.modelCfg,
      signal: deps.signal,
    });
  } else {
    res = await run(system, userPrompt);
  }

  if (!res.ok) {
    return {
      ok: false,
      results: [{ key: roleKey, ...res }],
      merged: null,
      error: res.error,
    };
  }
  return {
    ok: true,
    results: [{ key: roleKey, ...res }],
    merged: res.json || null,
  };
}

/** Render plan gọn (compact cho main context). */
export function renderMergedPlan(plan, { maxTouchpoints = 20 } = {}) {
  const lines = ['📋 PLAN', '', 'Touchpoints:'];
  for (const t of (plan?.touchpoints || []).slice(0, maxTouchpoints)) {
    lines.push(
      `  - [${t.action || '?'}] ${t.item}${t.file ? `: ${t.file}` : ''} — ${t.reason || ''}`,
    );
  }
  const rest = (plan?.touchpoints || []).length - maxTouchpoints;
  if (rest > 0) lines.push(`  … (+${rest} touchpoints)`);
  if (plan?.files?.length)
    lines.push(`\nFiles (${plan.files.length}): ${plan.files.join(', ')}`);
  if (plan?.tests?.length) lines.push(`Tests: ${plan.tests.join(', ')}`);
  if (plan?.risks?.length) lines.push(`Rủi ro: ${plan.risks.join(' · ')}`);
  if (plan?.assumptions?.length)
    lines.push(`\n⚠️ Assumptions: ${plan.assumptions.join(' · ')}`);
  if (plan?.unknowns?.length)
    lines.push(`❓ Unknowns: ${plan.unknowns.join(' · ')}`);
  return lines.join('\n');
}
