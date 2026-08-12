/**
 * Context helpers — resolve repo root từ cwd + build opts từ settings.
 * (Pattern code-reader: settings đọc live mỗi lần chạy tool, không bắt cứng.)
 */
import { realpath, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

/** Walk up từ cwd tìm git root HOẶC Laravel root (artisan) HOẶC thư mục chứa package.json/composer.json. */
export async function resolveRepoRoot(cwd) {
  if (!cwd) return null;
  let dir = await realpath(resolve(cwd)).catch(() => resolve(cwd));
  for (;;) {
    // Laravel app root — ưu tiên cao nhất (monorepo: dừng ở app, không đi tiếp lên repo gốc)
    try {
      await access(resolve(dir, 'artisan'));
      return await realpath(dir).catch(() => dir);
    } catch {
      /* chưa phải Laravel root */
    }
    try {
      await access(resolve(dir, '.git'));
      return await realpath(dir).catch(() => dir);
    } catch {
      /* chưa phải git root */
    }
    try {
      await access(resolve(dir, 'package.json'));
      await access(resolve(dir, 'composer.json'));
      const parent = dirname(dir);
      if (parent !== dir) {
        const hasGitAbove = await hasGitAncestor(parent);
        if (!hasGitAbove) return await realpath(dir).catch(() => dir);
      }
    } catch {
      /* chưa phải package root */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function hasGitAncestor(dir) {
  let d = dir;
  for (;;) {
    try {
      await access(resolve(d, '.git'));
      return true;
    } catch {
      /* tiếp tục */
    }
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/** Build opts từ extension settings (inject vào ctx.extensionSettings). */
export function settingsOpts(ctx = {}, base = {}) {
  const s = ctx?.extensionSettings || {};
  const opts = { ...base };
  if (s.php_bin) opts.phpBin = s.php_bin;
  if (s.command_timeout_ms) opts.timeoutMs = Number(s.command_timeout_ms);
  return opts;
}

/** Resolve repo root từ params/ctx, trả error-result nếu không có. */
export async function resolveRootOrError(params = {}, ctx = {}) {
  const cwd = params.cwd || ctx?.cwd || process.cwd();
  const root = await resolveRepoRoot(cwd);
  if (!root) {
    return {
      ok: false,
      content: [
        {
          type: 'text',
          text: 'Không xác định được repo root từ cwd. Làm việc trong git repo (hoặc thư mục có composer.json) rồi thử lại.',
        },
      ],
    };
  }
  return { ok: true, root };
}

/** Kiểm tra repo có phải Laravel không (có artisan + composer.json). */
export async function isLaravelRepo(root) {
  try {
    await access(resolve(root, 'artisan'));
    await access(resolve(root, 'composer.json'));
    return true;
  } catch {
    return false;
  }
}
