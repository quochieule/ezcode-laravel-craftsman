/**
 * explorer.js — Stage ④: Active Explorer (đặc tả §6.6).
 *
 * Checklist deterministic quyết định PHẢI PHỦ GÌ; explorer quyết định ĐI SÂU ĐÂU:
 * vòng lặp có giới hạn: LLM chọn file cần đọc tiếp (từ kết quả scan/grep), đọc
 * (Node fs — 0 token), chưng cất thành facts vào Understanding Map.
 *
 * Ngân sách hào phóng nhưng có giới hạn (explore_budget) — luôn có lối ra.
 */
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { callModel } from '../llm.js';

const MAX_LINES_PER_FILE = 120;

/** Đọc file giới hạn dòng → text (0 token vào context chính). */
export async function readBounded(file, maxLines = MAX_LINES_PER_FILE) {
  const content = await readFile(file, 'utf8').catch(() => null);
  if (content === null) return null;
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;
  return (
    lines.slice(0, maxLines).join('\n') +
    `\n… [${lines.length - maxLines} dòng nữa — cần đọc tiếp nếu quan trọng]`
  );
}

/** Trích "facts" thô từ nội dung file — signature của class/function/route gọi tới. */
export function extractFacts(file, content) {
  const facts = [];
  if (!content) return facts;
  let m;
  const classRe = /(?:class|interface|trait)\s+([A-Za-z_][\w]*)/g;
  while ((m = classRe.exec(content))) facts.push(`class:${m[1]}`);
  const fnRe =
    /(?:public|private|protected|static)?\s*function\s+([A-Za-z_][\w]*)\s*\(/g;
  while ((m = fnRe.exec(content))) facts.push(`function:${m[1]}`);
  const useRe = /\buse\s+([A-Za-z_\\][\w\\]*)/g;
  while ((m = useRe.exec(content)))
    facts.push(`uses:${m[1].split('\\').pop()}`);
  return [...new Set(facts)];
}

/**
 * Vòng explore có điều khiển.
 * @param {object} input { root, goal, focusFiles: string[] (paths tương đối), seedHints: string }
 * @param {object} deps { models, modelCfg, signal, runner?, budget? }
 * @returns {Promise<{facts:Array<{file:string, facts:string[]}>, readFiles:string[], notes:string}>}
 */
export async function explore(
  { root, goal, focusFiles = [], seedHints = '' },
  deps,
) {
  const { models, modelCfg, signal, runner } = deps;
  const budget = deps.budget ?? 30;
  const run =
    runner ||
    ((sys, user) =>
      callModel(models, modelCfg, {
        systemPrompt: sys,
        userPrompt: user,
        jsonMode: true,
        signal,
      }));

  const out = { facts: [], readFiles: [], notes: [] };
  const readSet = new Set();

  // v0.6 — "tất cả chỉ chạy 1 lần": bỏ vòng lặp LLM (trước: ~15 call nối tiếp).
  // Giờ: đọc seed files (0 LLM) → 1 LLM call DUY NHẤT chọn tối đa 3 file cần
  // đọc tiếp → đọc xong là dừng. Tổng tối đa 2 call LLM (thường 1 hoặc 0).
  const readOne = async (rel) => {
    const abs = isAbsolute(rel) ? rel : join(root, rel);
    if (readSet.has(abs)) return null;
    readSet.add(abs);
    const content = await readBounded(abs);
    if (content === null) {
      out.notes.push(`⚠️ ${rel} không đọc được (file không tồn tại?)`);
      return null;
    }
    const facts = extractFacts(abs, content);
    out.facts.push({ file: rel, facts });
    out.readFiles.push(rel);
    return content;
  };

  // ① Đọc seed files (từ mentions trong requirements/context) — 0 LLM
  const seeds = [...focusFiles].filter(Boolean).slice(0, budget || 30);
  const seedContents = [];
  for (const rel of seeds) {
    const content = await readOne(rel);
    if (content) seedContents.push({ rel, content });
  }

  // ② 1 LLM call DUY NHẤT: chọn tối đa 3 file cần đọc tiếp (từ nội dung seeds)
  if (signal?.aborted) return out;
  if (seedContents.length > 0) {
    const seen = seedContents.map((s) => s.rel).join(', ');
    const res = await run(
      'Bạn là kỹ sư explore codebase Laravel. Dựa trên nội dung các file đã đọc, ' +
        'chọn tối đa 3 file CẦN đọc tiếp để hiểu đủ luồng của yêu cầu. ' +
        'Trả JSON: {"next":["đường dẫn tương đối"]}. ' +
        'Nếu đã đủ hiểu → {"next":[]}. Chỉ chọn file thật sự liên quan, không đoán mò.',
      `YÊU CẦU: ${String(goal).slice(0, 800)}\nĐÃ ĐỌC: ${seen}\n` +
        seedContents
          .map((s) => `${s.rel}:\n${(s.content || '').slice(0, 1200)}`)
          .join('\n\n')
          .slice(0, 6000) +
        `\n${seedHints ? `HINTS: ${seedHints}` : ''}`,
    );
    if (res.ok) {
      // ③ Đọc các file được chọn (0 LLM nữa) rồi dừng
      for (const n of res.json?.next || []) {
        if (typeof n === 'string') await readOne(n);
      }
    }
  }

  return out;
}

/** Render facts gọn cho evidence pack. */
export function renderExplorerFacts(exp) {
  if (!exp.facts.length) return '(explorer chưa đọc được file nào)';
  const lines = exp.facts
    .map((f) => `- ${f.file}: ${f.facts.join(', ')}`)
    .slice(0, 60);
  return (
    lines.join('\n') + (exp.notes?.length ? `\n${exp.notes.join('\n')}` : '')
  );
}
