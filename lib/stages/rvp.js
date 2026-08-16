/**
 * rvp.js — Re-Verification Protocol (đặc tả §6.11): 3 kênh ĐỘC LẬP.
 *
 * Kênh 1 — Deterministic ground truth: chạy LẠI mọi check cứng + reality (test).
 * Kênh 2 — Adversarial panel fresh-eyes: verifier chỉ nhận plan + diff + file list,
 *          KHÔNG thấy hội thoại gốc (chống anchor); gap không evidence = loại.
 * Kênh 3 — Reality: file tồn tại, git diff tồn tại, (tùy chọn) chạy test thật.
 *
 * Báo cáo bắt buộc: ✓ N xác minh · ✗ K thiếu (kèm file:dòng) · ? U không kiểm tra được.
 */
import { checkFilesExist, checkChecklistCoverage } from './critic.js';
import { callModel } from '../llm.js';

/** ── Kênh 1 + 3: deterministic + reality ── */
export async function deterministicChannel({
  root,
  plan,
  checklistIds = [],
  runTests,
  exec,
}) {
  const checked = [];
  const missing = [];
  const unverifiable = [];

  // file tồn tại (reality)
  const missingFiles = await checkFilesExist(root, plan?.files || []);
  for (const f of plan?.files || []) {
    checked.push({ item: `file:${f}`, ok: !missingFiles.includes(f) });
  }
  for (const f of missingFiles)
    missing.push({ item: `file:${f}`, evidence: 'fs check sau khi thực thi' });

  // checklist coverage
  const uncovered = checkChecklistCoverage(plan?.touchpoints, checklistIds);
  for (const id of uncovered) {
    missing.push({ item: `touchpoint:${id}`, evidence: 'blueprint checklist' });
  }

  // test thật (reality — tùy chọn, tốn thời gian)
  if (runTests && exec) {
    try {
      const out = await exec(['test', '--compact'], { timeoutMs: 180000 });
      checked.push({ item: 'php artisan test', ok: true });
      if (/FAIL|Error|✗/.test(out)) {
        missing.push({
          item: 'php artisan test',
          evidence: `test fail:\n${out.slice(-800)}`,
        });
      }
    } catch (e) {
      unverifiable.push({
        item: 'php artisan test',
        reason: e.message.slice(0, 300),
      });
    }
  }

  return { checked, missing, unverifiable };
}

const VERIFIER_PROMPT =
  'Bạn là verifier ĐỘC LẬP (red-team). NHIỆM VỤ: tìm lý do công việc này SAI hoặc THIẾU — ' +
  'KHÔNG được đánh giá "đúng". Bạn KHÔNG thấy hội thoại gốc — chỉ có plan + danh sách file + diff. ' +
  'Mỗi phát hiện PHẢI kèm bằng chứng (file:line, đoạn code, output lệnh). Phát hiện không có bằng chứng = loại bỏ. ' +
  'Báo cáo theo JSON: {"gaps":[{"what":"...","evidence":"file:line/đoạn code","severity":"blocking|advisory"}],' +
  '"unverifiable":[{"what":"...","reason":"vì sao không kiểm tra được"}]}. ' +
  'Báo cáo trống và KHÔNG có unverifiable = báo cáo thất bại (bạn phải liệt kê ít nhất những gì không kiểm tra được).';

/** ── Kênh 2: adversarial fresh-eyes — 1 verifier (không merge, không hội đồng) ── */
export async function adversarialChannel(
  { goal, plan, diffText, root: _root },
  deps,
) {
  const { models, modelCfg, signal, runner } = deps;

  // Không cấu hình model verifier → bỏ kênh SẠCH (không phải "không kiểm tra được")
  // (subagent mode không cần models — runner tự resolve model)
  if (
    !runner &&
    !deps.subagent &&
    (!models || !modelCfg?.provider || !modelCfg?.modelId)
  ) {
    return { gaps: [], unverifiable: [], skipped: true };
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

  // fresh eyes: KHÔNG có session/hội thoại gốc — chỉ artifact
  const userPrompt = [
    `YÊU CẦU GỐC: ${String(goal).slice(0, 1500)}`,
    `PLAN ĐÃ THỰC HIỆN:\n${JSON.stringify(plan || {}).slice(0, 4000)}`,
    diffText
      ? `DIFF/THAY ĐỔI (nếu có):\n${String(diffText).slice(0, 4000)}`
      : '(không có diff text)',
  ].join('\n\n');

  // 1 verifier — sub-agent thật có tool read → TỰ kiểm chứng evidence file:line
  // (giảm false-missing → giảm vòng lặp reverify), hoặc 1 LLM call jsonMode.
  let r;
  if (deps.subagent) {
    r = await deps.subagent.run({
      role: 'verifier',
      systemPrompt: VERIFIER_PROMPT,
      mission:
        `${userPrompt}\n\nKIỂM CHỨNG: dùng tool read/ls/find/grep để xác minh ` +
        `mọi evidence file:line trước khi báo gap. Gap không xác minh được = loại.`,
      modelCfg: deps.modelCfg,
      signal: deps.signal,
    });
  } else {
    r = await run(VERIFIER_PROMPT, userPrompt);
  }

  // Hợp nhất: gap không evidence = loại (1 verifier — không votes)
  const gaps = [];
  const unverifiable = [];
  if (r.ok) {
    for (const g of r.json?.gaps || []) {
      if (!g?.what || !g?.evidence) continue; // không evidence = loại
      gaps.push({
        what: g.what,
        evidence: g.evidence,
        severity: g.severity || 'advisory',
      });
    }
    for (const u of r.json?.unverifiable || []) {
      if (u?.what)
        unverifiable.push({
          what: u.what,
          reason: u.reason || 'verifier không kiểm tra được',
        });
    }
  } else {
    unverifiable.push({ what: `verifier fail: ${r.error}`, reason: 'model lỗi' });
  }
  return { gaps, unverifiable };
}

/**
 * RVP đầy đủ — chạy khi user hỏi "kiểm tra lại" hoặc auto sau task.
 * @returns {Promise<{checked:Array, missing:Array, unverifiable:Array, report:string}>}
 */
export async function runRvp(
  {
    root,
    goal,
    plan,
    checklistIds = [],
    diffText = '',
    runTests = false,
    exec = null,
  },
  deps,
) {
  // v0.6 — "không chạy song song": 2 kênh chạy TUẦN TỰ (deterministic fs nhanh,
  // rồi mới tới verifier LLM). Trước dùng Promise.all.
  const ch1 = await deterministicChannel({ root, plan, checklistIds, runTests, exec });
  const ch2 = await adversarialChannel({ goal, plan, diffText, root }, deps);

  const checked = [...ch1.checked];
  const missing = [
    ...ch1.missing.map((m) => ({ ...m, channel: 'deterministic' })),
    ...ch2.gaps
      .filter((g) => g.severity === 'blocking')
      .map((g) => ({
        item: g.what,
        evidence: g.evidence,
        channel: 'adversarial',
      })),
  ];
  const unverifiable = [...ch1.unverifiable, ...ch2.unverifiable];

  return {
    checked,
    missing,
    unverifiable,
    report: renderRvpReport({
      checked,
      missing,
      unverifiable,
      skippedAdversarial: ch2.skipped,
    }),
  };
}

export function renderRvpReport({
  checked,
  missing,
  unverifiable,
  skippedAdversarial,
}) {
  const lines = [
    '📋 BÁO CÁO KIỂM TRA (per-item, có evidence)',
    `  ✓ ${checked.length} mục xác minh`,
    `  ✗ ${missing.length} mục THIẾU/broken`,
    `  ? ${unverifiable.length} mục không kiểm tra được (khai báo công khai)`,
  ];
  if (skippedAdversarial) {
    lines.push(
      '  ℹ Kênh adversarial bỏ qua (chưa cấu hình Verifier model) — chỉ kênh deterministic + reality',
    );
  }
  for (const m of missing)
    lines.push(`  ✗ ${m.item} — ${m.evidence} [${m.channel}]`);
  for (const u of unverifiable) lines.push(`  ? ${u.what} — ${u.reason}`);
  if (!missing.length && !unverifiable.length)
    lines.push('  → Không phát hiện thiếu sót trong phạm vi đã kiểm tra.');
  return lines.join('\n');
}

/** Đọc diff text từ git (uncommitted) — cho verifier fresh-eyes. */
export async function gitDiffText(root, exec) {
  if (!exec) return '';
  try {
    return await exec(['diff', '--stat'], { timeoutMs: 15000 });
  } catch {
    return '';
  }
}
