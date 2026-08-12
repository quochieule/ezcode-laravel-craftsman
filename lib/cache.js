/**
 * cache.js — cache mtime-based cho các scan deterministic (fingerprint,
 * routes, contracts). Module-shared (lib/* dùng chung module cache giữa các
 * session) → cache được tái dùng; key theo workspace + loại scan.
 *
 * Nguyên tắc: scan lại khi có file thay đổi (mtime mới hơn lần scan trước).
 * Không bao giờ cache lỗi.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const store = new Map(); // key → { at, files: {path: mtimeMs}, value }

/** Snapshot mtime của danh sách file (không có file = snapshot rỗng). */
async function snapshot(files) {
  const snap = {};
  for (const f of files || []) {
    try {
      const st = await stat(f);
      snap[f] = st.mtimeMs;
    } catch {
      /* file biến mất = thay đổi */
      snap[f] = -1;
    }
  }
  return snap;
}

/**
 * get hoặc rebuild cache.
 * @param {string} key  vd `${root}::fingerprint`
 * @param {string[]} watchFiles  file quyết định freshness
 * @param {Function} build  () => Promise<value> — chỉ gọi khi cache miss
 * @returns {Promise<{value:any, cached:boolean}>}
 */
export async function cached(key, watchFiles, build) {
  const prev = store.get(key);
  const snap = await snapshot(watchFiles);

  if (prev && sameSnap(prev.snap, snap)) {
    return { value: prev.value, cached: true };
  }
  const value = await build();
  store.set(key, { at: Date.now(), snap, value });
  return { value, cached: false };
}

function sameSnap(a, b) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Liệt kê file .blade.php + .js làm watch list cho frontend scan. */
export async function watchFilesFor(root, dirs) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  async function walk(dir, depth) {
    if (depth < 0) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (
          e.name === 'node_modules' ||
          e.name === 'vendor' ||
          e.name.startsWith('.')
        )
          continue;
        await walk(join(dir, e.name), depth - 1);
      } else if (e.name.endsWith('.blade.php') || e.name.endsWith('.js')) {
        out.push(join(dir, e.name));
      }
    }
  }
  for (const d of dirs) {
    // file trực tiếp (composer.json, artisan) — không phải thư mục
    try {
      const st = await stat(d);
      if (st.isFile()) {
        out.push(d);
        continue;
      }
    } catch {
      continue;
    }
    await walk(d, 5);
  }
  return out;
}
