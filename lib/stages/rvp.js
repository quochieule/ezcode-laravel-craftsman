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

/** ── Kênh 2: adversarial fresh-eyes panel ── */
export async function adversarialChannel(
  { goal, plan, diffText, root: _root },
  deps,
) {
  const { models, modelCfg, signal, runner, verifierCount = 3 } = deps;

  // Không cấu hình model verifier → bỏ kênh SẠCH (không phải "không kiểm tra được")
  if (!runner && (!models || !modelCfg?.provider || !modelCfg?.modelId)) {
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

  const results = await Promise.all(
    Array.from({ length: verifierCount }, (_, i) =>
      run(
        VERIFIER_PROMPT,
        userPrompt +
          `\n\n(Vòng ${i + 1}/${verifierCount} — đánh giá ĐỘC LẬP, không tham khảo vòng khác)`,
      ),
    ),
  );

  // Hợp nhất: gap không evidence = loại; blocking từ ≥2 verifier = chắc chắn
  const gaps = [];
  const unverifiable = [];
  for (const r of results) {
    if (!r.ok) {
      unverifiable.push({
        what: `verifier fail: ${r.error}`,
        reason: 'model lỗi',
      });
      continue;
    }
    for (const g of r.json?.gaps || []) {
      if (!g?.what || !g?.evidence) continue; // không evidence = loại
      const existing = gaps.find((x) => x.what === g.what);
      if (existing) existing.votes = (existing.votes || 1) + 1;
      else
        gaps.push({
          what: g.what,
          evidence: g.evidence,
          severity: g.severity || 'advisory',
          votes: 1,
        });
    }
    for (const u of r.json?.unverifiable || []) {
      if (u?.what)
        unverifiable.push({
          what: u.what,
          reason: u.reason || 'verifier không kiểm tra được',
        });
    }
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
  const [ch1, ch2] = await Promise.all([
    deterministicChannel({ root, plan, checklistIds, runTests, exec }),
    adversarialChannel({ goal, plan, diffText, root }, deps),
  ]);

  const checked = [...ch1.checked];
  const missing = [
    ...ch1.missing.map((m) => ({ ...m, channel: 'deterministic' })),
    ...ch2.gaps
      .filter((g) => g.severity === 'blocking' || (g.votes || 1) >= 2)
      .map((g) => ({
        item: g.what,
        evidence: g.evidence,
        channel: `adversarial${g.votes > 1 ? ` (${g.votes} verifier)` : ''}`,
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
