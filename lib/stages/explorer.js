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
  const queue = [...focusFiles].filter(Boolean);

  let rounds = 0;
  while (queue.length > 0 && rounds < budget) {
    rounds++;
    const rel = queue.shift();
    const abs = isAbsolute(rel) ? rel : join(root, rel);
    if (readSet.has(abs)) continue;
    readSet.add(abs);

    const content = await readBounded(abs);
    if (content === null) {
      out.notes.push(`⚠️ ${rel} không đọc được (file không tồn tại?)`);
      continue;
    }
    const facts = extractFacts(abs, content);
    out.facts.push({ file: rel, facts });
    out.readFiles.push(rel);

    // LLM quyết định đọc tiếp file nào (tối đa 3/lượt) — dựa trên nội dung vừa đọc
    if (rounds % 2 === 0) {
      const res = await run(
        'Bạn là kỹ sư explore codebase Laravel. Dựa trên nội dung file vừa đọc, chọn tối đa 3 file ' +
          'CẦN đọc tiếp để hiểu đủ luồng của yêu cầu. Trả JSON: {"next":["đường dẫn tương đối"]}. ' +
          'Nếu đã đủ hiểu → {"next":[]}. Chỉ chọn file thật sự liên quan, không đoán mò.',
        `YÊU CẦU: ${String(goal).slice(0, 800)}\nVỪA ĐỌC: ${rel}\n${(content || '').slice(0, 2500)}\n${seedHints ? `HINTS: ${seedHints}` : ''}`,
      );
      if (res.ok) {
        for (const n of res.json?.next || []) {
          if (typeof n === 'string' && !readSet.has(join(root, n)))
            queue.push(n);
        }
      }
    }
  }

  if (queue.length > 0)
    out.notes.push(
      `⏹ hết ngân sách explore (${budget} bước) — còn ${queue.length} file chưa đọc`,
    );
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
