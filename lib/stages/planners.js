/**
 * planners.js — Stage ⑤: 5 subagent plan SONG SONG + hội đồng merge (đặc tả §6.8).
 *
 * 1 Kiến trúc sư backend · 2 Frontend Contract ★ · 3 Data Layer
 * 4 Security & Auth · 5 Risk & Test
 *
 * Luật:
 *   - Mỗi planner: context riêng, evidence pack riêng (theo vai), cùng output schema
 *   - Hội đồng: đồng thuận = chốt · bất đồng = theo bằng chứng · 1 bên thấy = kiểm chứng
 */
import { callModel } from '../llm.js';

const PLAN_SCHEMA_HINT =
  'Trả JSON thuần theo schema: ' +
  '{"touchpoints":[{"item":"route","action":"existing|new|modify","file":"đường dẫn tương đối","reason":"1 dòng"}],' +
  '"files":["file sẽ đụng"],"tests":["test sẽ thêm/sửa"],"risks":["rủi ro ngắn"],' +
  '"assumptions":["giả định chưa xác minh"],"unknowns":["thứ chưa kiểm tra được với dữ liệu hiện có"]}';

const ROLES = [
  {
    key: 'architect',
    label: 'Kiến trúc sư backend',
    system:
      'Bạn là kiến trúc sư Laravel kỳ cựu, nhìn TOP-DOWN. Nhiệm vụ: xác định module/layer nào bị đụng, ' +
      'thiết kế luồng chính, ai chịu trách nhiệm logic (controller mỏng? service?). Chỉ dùng dữ liệu được cấp. ' +
      'KHÔNG bịa file/package/API. ' +
      PLAN_SCHEMA_HINT,
  },
  {
    key: 'frontend',
    label: 'Frontend Contract',
    system:
      'Bạn là chuyên gia Laravel + Blade + jQuery/Ajax. Nhiệm vụ SỐ 1: giữ chuỗi contract frontend↔backend ' +
      'không đứt — selector phải khớp DOM blade (kể cả partial/AJAX partial), AJAX url phải khớp route thật, ' +
      'CSRF đúng convention, success/error callback cập nhật DOM target tồn tại. Nếu contract map chỉ ra broken ' +
      'link — phải đưa vào touchpoints để sửa. ' +
      PLAN_SCHEMA_HINT,
  },
  {
    key: 'data',
    label: 'Data Layer',
    system:
      'Bạn là chuyên gia dữ liệu Laravel (Eloquent + migrations). Nhiệm vụ: đối chiếu mọi thay đổi với ' +
      'SCHEMA THẬT từ migrations — cột mới cần migration? enum values đúng? relationship khớp khóa ngoại? ' +
      'Cảnh báo N+1 và thiếu index cho query nặng. ' +
      PLAN_SCHEMA_HINT,
  },
  {
    key: 'security',
    label: 'Security & Auth',
    system:
      'Bạn là chuyên gia bảo mật Laravel. Nhiệm vụ: middleware/phân quyền (Policy/Gate theo convention repo), ' +
      'validation đầy đủ, CSRF, mass assignment (fillable), XSS trong blade ({{ }} vs {!! !!}), authorization ở đúng tầng. ' +
      PLAN_SCHEMA_HINT,
  },
  {
    key: 'risk',
    label: 'Risk & Test',
    system:
      'Bạn là QA + kỹ sư phản biện. NHIỆM VỤ CỦA BẠN LÀ TÌM LÝ DO KẾ HOẠCH SAI/THIẾU — không phải khen. ' +
      'Check: touchpoint nào bị sót, edge case nào vỡ, guard nào thiếu test, caller nào bị ảnh hưởng, dead-code risk. ' +
      'Mỗi risk phải kèm evidence (file/thứ đã thấy trong dữ liệu). ' +
      PLAN_SCHEMA_HINT,
  },
];

/** Đóng gói evidence theo vai — pack riêng, token cap theo vai. */
export function packForRole(key, facts) {
  const packs = {
    architect: ['fingerprint', 'architecture', 'routes', 'schema', 'checklist']
      .map((k) => facts[k])
      .filter(Boolean),
    frontend: ['frontend', 'contracts', 'routes', 'checklist']
      .map((k) => facts[k])
      .filter(Boolean),
    data: ['schema', 'routes', 'fingerprint']
      .map((k) => facts[k])
      .filter(Boolean),
    security: ['fingerprint', 'routes', 'checklist']
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
 * Chạy 5 planners song song + merge.
 * @param {object} input { goal, context, facts { fingerprint, schema, routes, frontend, contracts, checklist }, featureType }
 * @param {object} deps { models, modelCfg, signal, runner? }
 */
export async function runPlanners(
  { goal, context = '', facts, featureType = '' },
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

  // roleKeys: giới hạn vai chạy (vòng re-plan chỉ cần risk) — mặc định đủ 5 vai
  const roles = (deps.roleKeys || ROLES.map((r) => r.key))
    .map((k) => ROLES.find((r) => r.key === k))
    .filter(Boolean);

  const goalText = `YÊU CẦU:\n${String(goal).slice(0, 2000)}${context ? `\nNGỮ CẢNH:\n${context.slice(0, 1500)}` : ''}`;

  const results = await Promise.all(
    roles.map(async (role) => {
      const userPrompt = [
        goalText,
        `LOẠI FEATURE: ${featureType || 'general'}`,
        `DỮ LIỆU THẬT (chỉ dùng cái này, không bịa):\n${packForRole(role.key, facts)}`,
        `Giới hạn: tối đa 20 touchpoints.`,
      ].join('\n\n');
      const res = await run(role.system, userPrompt);
      return { key: role.key, label: role.label, ...res };
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
  const merged = mergePlans(jsons);
  return { ok: true, results, merged };
}

/** Hội đồng merge 5 plans (đặc tả §6.8). */
export function mergePlans(jsons) {
  const union = (key) => {
    const set = new Set();
    for (const j of jsons)
      for (const x of j?.[key] || [])
        if (String(x).trim()) set.add(String(x).trim());
    return [...set];
  };

  // touchpoints: union theo item name; bất đồng action → giữ tất cả, đánh dấu
  const touchpoints = [];
  const byItem = new Map();
  for (const j of jsons) {
    for (const t of j?.touchpoints || []) {
      if (!t?.item) continue;
      if (byItem.has(t.item)) {
        const prev = byItem.get(t.item);
        if (prev.action !== t.action) {
          prev.conflict = [prev.action, t.action];
          prev.reason += ` | ${t.reason || ''}`;
        } else if (t.file && !prev.file) {
          prev.file = t.file;
        }
      } else {
        const copy = { ...t };
        byItem.set(t.item, copy);
        touchpoints.push(copy);
      }
    }
  }

  return {
    touchpoints,
    files: union('files'),
    tests: union('tests'),
    risks: union('risks'),
    assumptions: union('assumptions'),
    unknowns: union('unknowns'),
    planCount: jsons.length,
  };
}

/** Render plan hợp nhất gọn (compact cho main context). */
export function renderMergedPlan(plan, { maxTouchpoints = 20 } = {}) {
  const lines = [
    `📋 PLAN (${plan.planCount || 1} planner hội đồng)`,
    '',
    'Touchpoints:',
  ];
  for (const t of (plan.touchpoints || []).slice(0, maxTouchpoints)) {
    const conflict = t.conflict ? ` ⚠️ bất đồng:${t.conflict.join('/')}` : '';
    lines.push(
      `  - [${t.action || '?'}] ${t.item}${t.file ? `: ${t.file}` : ''} — ${t.reason || ''}${conflict}`,
    );
  }
  const rest = (plan.touchpoints || []).length - maxTouchpoints;
  if (rest > 0) lines.push(`  … (+${rest} touchpoints)`);
  if (plan.files?.length)
    lines.push(`\nFiles (${plan.files.length}): ${plan.files.join(', ')}`);
  if (plan.tests?.length) lines.push(`Tests: ${plan.tests.join(', ')}`);
  if (plan.risks?.length) lines.push(`Rủi ro: ${plan.risks.join(' · ')}`);
  if (plan.assumptions?.length)
    lines.push(`\n⚠️ Assumptions: ${plan.assumptions.join(' · ')}`);
  if (plan.unknowns?.length)
    lines.push(`❓ Unknowns: ${plan.unknowns.join(' · ')}`);
  return lines.join('\n');
}
