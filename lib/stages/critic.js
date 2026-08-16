/**
 * critic.js — Stage ⑥: phản biện plan (đặc tả §6.9).
 *
 * 🔴 blocking: hallucination (file/symbol tồn tại?) · checklist thiếu · contract lệch
 *              · claim sai (đọc LẠI code thật từng claim)
 * 🟡 advisory: lệch convention · test thiếu nhánh hiếm → unknowns, không chặn
 *
 * Xương sống DETERMINISTIC — LLM chỉ chấm điểm + giải thích.
 */
import { access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';

/** 🔴 Check 1: file trong plan có tồn tại? */
export async function checkFilesExist(root, files) {
  const missing = [];
  for (const f of files || []) {
    const p = isAbsolute(f) ? f : join(root, f);
    try {
      await access(p);
    } catch {
      missing.push(f);
    }
  }
  return missing;
}

/** 🔴 Check 2: touchpoint trong plan có nằm trong checklist feature-type không (hoặc có lý do)? */
export function checkChecklistCoverage(planTouchpoints, checklistIds) {
  const have = new Set((planTouchpoints || []).map((t) => t.item));
  return checklistIds.filter((id) => !have.has(id));
}

/** Tên touchpoint generic — không phải symbol, không verify claim */
const GENERIC_ITEMS = new Set([
  'route',
  'controller',
  'service',
  'model',
  'migration',
  'validation',
  'policy',
  'view',
  'js',
  'ajax',
  'callback',
  'side-effect',
  'test',
  'log',
  'endpoint',
  'api',
  'form',
  'response',
  'request',
  'schema',
  'command',
  'job',
  'queue',
  'notification',
  'mail',
  'event',
  'listener',
  'observer',
  'config',
  'seed',
  'factory',
  'middleware',
  'resource',
  'auth',
]);

/** 🔴 Check 3: claim-level verification — symbol được cite có thật trong file? */
export async function verifyClaims(root, touchpoints) {
  const failed = [];
  for (const t of touchpoints || []) {
    if (!t?.file) continue;
    // touchpoint tên chung (route/controller/view...) → không phải symbol, bỏ qua
    if (GENERIC_ITEMS.has(String(t.item).toLowerCase())) continue;
    const p = isAbsolute(t.file) ? t.file : join(root, t.file);
    const content = await readFile(p, 'utf8').catch(() => '');
    if (!content) continue; // file tồn tại nhưng không đọc được → bỏ qua
    // dạng Class@method — phải có cả class lẫn method trong file
    const at = t.item.match(/([A-Za-z_][\w]*)?@([\w]+)/);
    if (at) {
      const [, cls, method] = at;
      if (cls && !content.includes(cls)) {
        failed.push({
          item: t.item,
          file: t.file,
          reason: `không tìm thấy class "${cls}" trong file`,
        });
      } else if (!new RegExp(`function\\s+${method}\\s*\\(`).test(content)) {
        failed.push({
          item: t.item,
          file: t.file,
          reason: `không tìm thấy method "${method}" trong file`,
        });
      }
      continue;
    }
    // tên symbol thuần (service/model/controller...) — phải có mặt trong file
    if (
      /\b(controller|service|model|handler|job|listener|policy)\b/i.test(t.item)
    ) {
      const name = t.item.match(/[A-Za-z_][\w]*/)?.[0];
      if (name && !content.includes(name)) {
        failed.push({
          item: t.item,
          file: t.file,
          reason: `không tìm thấy "${name}" trong file`,
        });
      }
    }
  }
  return failed;
}

/**
 * Critic đầy đủ (DETERMINISTIC — 0 LLM call).
 * @param {object} input { root, plan, checklistIds, contractDiffResult, goal, learnedChecks? }
 * @param {object} deps — giữ để tương thích (không dùng LLM)
 * @returns {Promise<{ok, blocking:Array, advisory:Array, score:number, unknowns:Array, report:string}>}
 */
export async function critic(
  {
    root,
    plan,
    checklistIds = [],
    contractDiffResult = null,
    goal: _goal = '',
    learnedChecks = [],
  },
  _deps,
) {
  const blocking = [];
  const advisory = [];

  // 🔴 hallucination
  const missingFiles = await checkFilesExist(root, plan?.files || []);
  for (const f of missingFiles) {
    blocking.push({
      check: 'hallucination',
      detail: `File trong plan KHÔNG tồn tại: ${f}`,
      evidence: 'fs check',
    });
  }

  // 🔴 checklist coverage
  const uncovered = checkChecklistCoverage(plan?.touchpoints, checklistIds);
  for (const id of uncovered) {
    blocking.push({
      check: 'checklist',
      detail: `Touchpoint bắt buộc thiếu trong plan: ${id}`,
      evidence: 'blueprint checklist',
    });
  }

  // 🔴 claim verification
  const claimFails = await verifyClaims(root, plan?.touchpoints || []);
  for (const c of claimFails) {
    blocking.push({
      check: 'claim',
      detail: `${c.item} — ${c.reason}`,
      evidence: c.file,
    });
  }

  // 🔴 contract diff (nếu có dữ liệu để diff)
  if (contractDiffResult?.mismatches?.length) {
    for (const m of contractDiffResult.mismatches) {
      blocking.push({
        check: 'contract-diff',
        detail: `${m.between}: "${m.key}" không khớp`,
        evidence: 'cross-layer set-diff',
      });
    }
  }

  // 🟡 advisory: thiếu tests
  if (!plan?.tests?.length) {
    advisory.push({
      check: 'tests',
      detail: 'Plan không đề cập test nào',
      evidence: 'plan.tests rỗng',
    });
  }
  // 🟡 advisory: assumptions không được đánh dấu trong touchpoints
  if (plan?.assumptions?.length) {
    advisory.push({
      check: 'assumptions',
      detail: `${plan.assumptions.length} giả định chưa xác minh — phải kiểm tra khi thực thi`,
      evidence: 'plan.assumptions',
    });
  }
  // 🟡 advisory: lỗi lịch sử repo (learned-checks — GHI ở reverify, giờ ĐỌC ở đây)
  // Không block (check là câu tự do, không khớp touchpoint) — chỉ nhắc agent verify
  for (const lc of learnedChecks || []) {
    advisory.push({
      check: 'learned',
      detail: `Lịch sử repo từng thiếu: ${lc.check || lc}`,
      evidence: 'learned-checks.json',
    });
  }

  // ── Score (deterministic trọng số cao) ──
  const fileScore = plan?.files?.length
    ? (plan.files.length - missingFiles.length) / plan.files.length
    : 0.5;
  const checklistScore = checklistIds.length
    ? (checklistIds.length - uncovered.length) / checklistIds.length
    : 1;
  const contractScore = contractDiffResult?.mismatches?.length ? 0 : 1;
  const score =
    Math.round(
      (fileScore * 0.4 + checklistScore * 0.3 + contractScore * 0.3) * 100,
    ) / 100;

  // ── Unknowns (từ plan + advisory) ──
  const unknowns = [
    ...(plan?.unknowns || []).map((u) => ({
      what: u,
      why: 'planner khai báo',
    })),
    ...(plan?.assumptions || []).map((a) => ({
      what: a,
      why: 'giả định chưa xác minh',
    })),
  ];

  const report = renderCriticReport({ blocking, advisory, score, unknowns });
  return {
    ok: blocking.length === 0,
    blocking,
    advisory,
    score,
    unknowns,
    report,
  };
}

export function renderCriticReport({ blocking, advisory, score, unknowns }) {
  const lines = [`CRITIC REPORT — score: ${score}`];
  if (blocking.length) {
    lines.push(`\n🔴 BLOCKING (${blocking.length}) — phải sửa trước khi chốt:`);
    for (const b of blocking) lines.push(`  - [${b.check}] ${b.detail}`);
  }
  if (advisory.length) {
    lines.push(`\n🟡 ADVISORY (${advisory.length}):`);
    for (const a of advisory) lines.push(`  - [${a.check}] ${a.detail}`);
  }
  if (unknowns.length) {
    lines.push(`\n❓ UNKNOWNS (${unknowns.length}):`);
    for (const u of unknowns) lines.push(`  - ${u.what} (${u.why})`);
  }
  if (!blocking.length && !advisory.length && !unknowns.length) {
    lines.push('\nKhông có vấn đề nào được phát hiện.');
  }
  return lines.join('\n');
}
