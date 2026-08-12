/**
 * exec helpers — chạy `php artisan` và lệnh hệ thống an toàn từ extension.
 *
 * Bài học từ ENHANCE.md (code-reader):
 *   - `exec` giết tiến trình con khi output vượt maxBuffer — phải để maxBuffer
 *     đủ lớn (20 MB) cho output của artisan/test.
 *   - Không ném stack lộn xộn — trả stderr tail để agent tự sửa được.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Giữ phần đuôi output (cho thông báo lỗi gọn). */
export function tail(s, n = 1500) {
  return String(s ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-20)
    .join('\n')
    .slice(-n);
}

/**
 * Chạy `php artisan <args...>` trong cwd.
 * @param {string} cwd  thư mục repo Laravel
 * @param {string[]} args  ví dụ ['route:list', '--json']
 * @param {object} opts { phpBin?, timeoutMs?, signal? }
 * @returns {Promise<string>} stdout
 * @throws {Error} kèm stderr tail khi artisan fail
 */
export async function runArtisan(cwd, args, opts = {}) {
  const php = opts.phpBin || process.env.PHP_BIN || 'php';
  try {
    const { stdout } = await execFileAsync(php, ['artisan', ...args], {
      cwd,
      timeout: opts.timeoutMs ?? 60000,
      maxBuffer: 20 * 1024 * 1024,
      signal: opts.signal,
      windowsHide: true,
    });
    return stdout;
  } catch (e) {
    // 127 = php không có trong PATH
    const hint =
      e.code === 'ENOENT' || /127/.test(e.message)
        ? `php không tìm thấy (đã thử: ${php}). Cài PHP hoặc đặt 'php_bin' trong Settings → Extensions → Laravel Craftsman.`
        : `artisan ${args[0]} fail: ${tail(e.stderr || e.message)}`;
    throw new Error(hint, { cause: e });
  }
}

/**
 * Chạy 1 lệnh thường (không phải artisan) — dùng cho scan repo.
 * @returns {Promise<string>} stdout
 */
export async function run(cmd, args, opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 30000,
    maxBuffer: 20 * 1024 * 1024,
    signal: opts.signal,
    windowsHide: true,
  });
  return stdout;
}
