/**
 * memory.js — learning loop (đặc tả §6.12 + §8): episodes + knowledge JSONL.
 *
 * Lưu theo workspace: <repoRoot>/.ezcode/laravel-craftsman/ (pattern extension memory).
 * Mỗi episode: task → files đọc/sửa → outcome → lessons → checklist updates.
 * Learning = lỗi user tìm ra → check mới vĩnh viễn (không "xin lỗi").
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { access } from 'node:fs/promises';

export function dataDirFor(root) {
  return join(root, '.ezcode', 'laravel-craftsman');
}

/** Ghi episode (append-only, atomic rename). */
export async function addEpisode(root, episode) {
  const dir = dataDirFor(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'episodes.jsonl');
  const row = JSON.stringify({
    id: `ep-${Date.now()}`,
    ts: Date.now(),
    ...episode,
  });
  const prev = await readFile(file, 'utf8').catch(() => '');
  await writeFile(file, prev + row + '\n', 'utf8');
  return row;
}

/** Đọc N episode gần nhất. */
export async function recentEpisodes(root, limit = 10) {
  const file = join(dataDirFor(root), 'episodes.jsonl');
  const raw = await readFile(file, 'utf8').catch(() => '');
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return rows.slice(-limit).reverse();
}

/** ── Checklist updates (học từ lỗi → thêm check vĩnh viễn) ── */
export async function addLearnedCheck(root, { trigger, check, source }) {
  const dir = dataDirFor(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'learned-checks.json');
  const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
  if (prev.some((c) => c.check === check)) return prev;
  prev.push({ trigger, check, source, ts: Date.now() });
  await writeFile(file, JSON.stringify(prev, null, 2), 'utf8');
  return prev;
}

export async function learnedChecks(root) {
  const file = join(dataDirFor(root), 'learned-checks.json');
  return JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
}

/** ── Knowledge (quyết định đã chốt / convention đã học) ── */
export async function saveKnowledge(root, { kind, content, source = 'agent' }) {
  const dir = dataDirFor(root);
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'knowledge.json');
  const prev = JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
  const existing = prev.find((k) => k.kind === kind && k.content === content);
  if (existing) return prev;
  prev.push({ id: `k-${Date.now()}`, kind, content, source, ts: Date.now() });
  await writeFile(file, JSON.stringify(prev, null, 2), 'utf8');
  return prev;
}

export async function recallKnowledge(root, query = '') {
  const file = join(dataDirFor(root), 'knowledge.json');
  const rows = JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
  if (!query) return rows;
  const q = String(query).toLowerCase();
  return rows.filter((k) => `${k.kind} ${k.content}`.toLowerCase().includes(q));
}

/** Session summary cho prompt-critics — đọc từ session manager (nếu có). */
export async function sessionSummary(ctx) {
  try {
    const entries = ctx?.sessionManager?.getEntries?.() || [];
    if (!entries.length) return '';
    const lines = [];
    for (const e of entries.slice(-40)) {
      const role = e?.role || e?.type || '?';
      if (role === 'tool' || role === 'tool_result') continue;
      const content = Array.isArray(e?.content)
        ? e.content
            .map((c) => c?.text || '')
            .join(' ')
            .slice(0, 400)
        : String(e?.content || '').slice(0, 400);
      if (content.trim()) lines.push(`[${role}] ${content}`);
    }
    return lines.join('\n').slice(0, 4000);
  } catch {
    return '';
  }
}

export { access };
