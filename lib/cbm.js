// `exec` dùng ở đường auto-install (chạy chuỗi lệnh qua shell mặc định).
// Thiếu import này thì auto-install ném ReferenceError — lint no-undef bắt được,
// nghĩa là nhánh đó chưa từng chạy thành công lần nào.
import { execFile, exec } from 'node:child_process';
import { realpath, access } from 'fs/promises';
import { dirname, resolve, join } from 'node:path';

/**
 * codebase-memory-mcp (CBM) bridge — wraps the CLI mode so ezcode tools
 * can query the knowledge graph without running a persistent MCP daemon.
 *
 * Every tool comes through here to:
 *   1. Resolve the target repository root from ctx.cwd (walk up to .git / package.json).
 *   2. Find the matching indexed CBM project via list_projects (match on root_path).
 *   3. Auto-index the repo (mode: fast) on first use if it isn't indexed yet.
 *   4. Run `codebase-memory-mcp cli <tool> <json-args>` and parse the JSON result.
 */

const { promisify } = await import('node:util');
const execAsync = promisify(execFile);

// --- Binary resolution ---

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';
const BIN_NAME = IS_WIN ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
const SEP = IS_WIN ? '\\' : '/';

// Platform-aware candidate search order (resolved lazily at findBinary time so
// env-dependent paths like %LOCALAPPDATA% / $HOME work correctly per OS).
function platformBinaryCandidates() {
  const cands = [];
  if (IS_WIN) {
    const lap = process.env.LOCALAPPDATA;
    if (lap) cands.push(join(lap, 'Programs', 'codebase-memory-mcp', BIN_NAME));
    // Installer chính thức trên Windows thực tế đặt binary vào ~/.local/bin
    // (đo được: 273 MB ở đó), dù chính nó verify ở %LOCALAPPDATA%\Programs rồi
    // báo "installed binary failed to run". Không dò chỗ này thì binary có cài
    // vẫn coi như không có, cho tới khi restart shell để PATH có hiệu lực.
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) cands.push(join(home, '.local', 'bin', BIN_NAME));
  } else if (IS_MAC || IS_LINUX) {
    const home = process.env.HOME || '';
    cands.push(join(home, '.local', 'bin', BIN_NAME));
    cands.push('/usr/local/bin/' + BIN_NAME);
  }
  return cands;
}

async function findBinary(binPath) {
  const cands = [
    binPath,
    process.env.CBM_BIN,
    process.env.CODEBASE_MEMORY_MCP_BIN,
    ...platformBinaryCandidates(),
    BIN_NAME, // PATH fallback (bare name resolved via `command -v` / `where`)
  ].filter(Boolean);

  for (const bin of new Set(cands)) {
    // Absolute/explicit path → check existence directly.
    if (bin !== BIN_NAME && (bin.includes(SEP) || bin.includes('/'))) {
      try {
        await access(bin);
        return bin;
      } catch {
        /* missing — try next */
      }
      continue;
    }
    // Bare name → resolve through PATH (command -v on unix, where on windows).
    try {
      const probe = IS_WIN ? `where ${bin}` : `command -v ${bin}`;
      const { stdout } = await execAsync(
        IS_WIN ? 'cmd.exe' : 'sh',
        IS_WIN ? ['/c', probe] : ['-c', probe],
      );
      const found = stdout.trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch {
      /* not on PATH — try next */
    }
  }

  throw new Error(
    'codebase-memory-mcp binary not found. ' +
      (IS_WIN
        ? 'Install it first:\n  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 | iex"\n  or set CBM_BIN env var to its absolute path.'
        : 'Install it first:\n  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash\n  or set CBM_BIN / CODEBASE_MEMORY_MCP_BIN env var to its absolute path.'),
  );
}

let _binaryPromise = null;
let _lastBinPath = null;
function binary(binPath) {
  if (!_binaryPromise || (binPath && binPath !== _lastBinPath)) {
    _lastBinPath = binPath;
    _binaryPromise = findBinary(binPath).catch((e) => {
      _binaryPromise = null; // allow retry on next call
      throw e;
    });
  }
  return _binaryPromise;
}

// --- Install / auto-provision ---

/**
 * Decode the auto_install setting. The manifest uses a select of ["true","false"]
 * so the value may arrive as a string. Absent/empty ⇒ true (default), trusted
 * one-line installer from the CBM project; explicit "false"/false ⇒ never auto-install.
 */
function autoInstallEnabled(s = {}) {
  const v = s.auto_install;
  if (v === false || v === 'false' || v === 0) return false;
  return true;
}

/**
 * Run the official one-line installer for codebase-memory-mcp, choosing the
 * right mechanism per platform:
 *   - macOS/Linux: `curl -fsSL install.sh | bash -s -- --skip-config`
 *     → installs to ~/.local/bin/codebase-memory-mcp
 *   - Windows: `irm install.ps1 | iex` via PowerShell
 *     → installs to %LOCALAPPDATA%\Programs\codebase-memory-mcp\
 * Streaming; long timeout. Never touches coding-agent configs (--skip-config).
 * @param {AbortSignal} [signal]
 */
export async function installBinary(signal) {
  const script =
    'https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install';
  let cmd;
  if (IS_WIN) {
    // KHÔNG dùng one-liner `iex (irm ...)`: `iex` chạy script dạng CHUỖI nên
    // KHÔNG truyền được tham số, mà nhánh unix bên dưới lại truyền
    // `--skip-config`. Hệ quả trên Windows: installer chạy tiếp bước cấu hình
    // agent, bước đó lỗi → exit 1 → installer dọn tmp và KHÔNG để lại binary,
    // dù tải + verify checksum + giải nén đều đã thành công.
    //
    // Tải ra file tạm rồi gọi bằng `& $p --skip-config` để tham số tới được script.
    const inner = [
      `$p = Join-Path $env:TEMP 'cbm-install.ps1'`,
      `Invoke-WebRequest -UseBasicParsing '${script}.ps1' -OutFile $p`,
      `& $p --skip-config`,
    ].join('; ');
    cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${inner}"`;
  } else {
    // Require curl or wget.
    await execAsync('sh', ['-lc', 'command -v curl || command -v wget']).catch(
      () => {
        throw new Error(
          'Auto-install requires curl or wget to download codebase-memory-mcp.',
        );
      },
    );
    cmd = `curl -fsSL '${script}.sh' | bash -s -- --skip-config`;
  }

  await new Promise((resolveP, rejectP) => {
    // Default shell (cmd.exe on Windows, /bin/sh on unix) runs the command.
    //
    // maxBuffer: `exec` GIẾT tiến trình con khi output vượt ngưỡng — kể cả lệnh
    // đang chạy đúng. Ngưỡng cũ 8 KB làm installer (tải binary ~273 MB, in tiến
    // độ) bị SIGTERM giữa chừng rồi báo là "cài thất bại". Đã dựng lại bằng thực
    // nghiệm: cùng một lệnh exit 0, để 8 KB thì nhận SIGTERM, để 8 MB thì exit 0.
    const child = exec(cmd, {
      timeout: 300000,
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });

    // Giữ phần đuôi output: installer chính thức có hàng chục nhánh `exit 1`
    // (checksum lệch, kiến trúc lạ, redirect bị chặn…). Vứt hết output đi thì
    // người dùng chỉ nhận được "exit 1" và không có cách nào tự sửa.
    let tail = '';
    const keep = (chunk) => {
      tail = (tail + chunk).slice(-2000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);

    child.on('error', (e) =>
      rejectP(new Error(`Failed to start installer: ${e.message}`)),
    );
    child.on('exit', (code, sig) => {
      if (code === 0) return resolveP();
      rejectP(
        new Error(
          `codebase-memory-mcp auto-install failed (exit ${code}${
            sig ? `, signal ${sig}` : ''
          }). Install manually:\n` +
            (IS_WIN
              ? '  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 | iex"'
              : '  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash') +
            (tail.trim() ? `\n\nInstaller output (tail):\n${tail.trim()}` : ''),
        ),
      );
    });
  });

  _binaryPromise = null; // re-resolve after install
  await binary(); // confirm binary now resolves
}

/**
 * Ensure a usable CBM binary is available. If none is found and the
 * `auto_install` setting is on (and tools/platform allow), install it once.
 *
 * @param {object} settings  extension settings (extensionSettings)
 * @param {object} [opts]    { signal? }
 * @returns {Promise<string>} resolved binary path
 * @throws {Error} with install instructions when binary is missing and not auto-installed
 */
export async function ensureBinary(settings = {}, opts = {}) {
  try {
    return await binary();
  } catch (missingErr) {
    if (autoInstallEnabled(settings)) {
      try {
        await installBinary(opts.signal);
        return await binary();
      } catch (e) {
        // Giữ `cause` để không mất stack gốc của lỗi cài đặt khi debug
        throw new Error(
          missingErr.message +
            '\n(Auto-install attempted but failed: ' +
            e.message +
            ')',
          { cause: e },
        );
      }
    }
    throw new Error(
      'codebase-memory-mcp binary is not installed. Install it once with:\n' +
        (IS_WIN
          ? '  powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.ps1 | iex"\n'
          : '  curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash\n') +
        'then restart ezcode. To let this extension install it automatically, enable the ' +
        '\u201cauto_install\u201d setting in Settings \u2192 Extensions \u2192 Code Reader.',
      { cause: missingErr },
    );
  }
}

// --- Dependency-free JSON-arg passing ---

// CBM cli accepts a raw JSON string as the single positional arg (last usage form),
// e.g. `codebase-memory-mcp cli <tool> '<json>'`. This avoids flag-escaping bugs.

/**
 * Run `codebase-memory-mcp cli <tool> <json>` and resolve to the parsed JSON.
 * @param {string} tool
 * @param {object} args
 * @param {object} opts { signal?, timeoutMs? }
 * @returns {Promise<{[k:string]: any} & {_stdout?: string}>}
 */
export function cbm(tool, args = {}, opts = {}) {
  return new Promise((resolveP, rejectP) => {
    binary(opts.bin)
      .then((bin) => {
        const child = execFile(
          bin,
          ['cli', tool, JSON.stringify(args)],
          {
            maxBuffer: 20 * 1024 * 1024, // 20 MB
            timeout: opts.timeoutMs ?? 120000,
            signal: opts.signal,
          },
          (err, stdout, stderr) => {
            if (err && !opts.signal?.aborted) {
              // Prefer stderr message if present, else the tool's JSON error envelope.
              const detail =
                (stderr || '')
                  .split('\n')
                  .filter(Boolean)
                  .slice(-5)
                  .join('\n') ||
                stdout ||
                err.message;
              return rejectP(
                new Error(
                  `codebase-memory-mcp ${tool} failed:\n${detail}`.trim(),
                ),
              );
            }
            try {
              const parsed = JSON.parse(stdout);
              resolveP(Object.assign(parsed, { _stdout: stdout }));
            } catch (e) {
              rejectP(
                new Error(
                  `codebase-memory-mcp ${tool} returned non-JSON output:\n${stdout || stderr}\n${e.message}`,
                ),
              );
            }
          },
        );
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => child.kill('SIGKILL'), {
            once: true,
          });
        }
      })
      .catch(rejectP);
  });
}

// --- Project resolution ---

/**
 * Walk up from a working dir to find the git repository root OR the nearest
 * directory containing a package.json. Stops at the filesystem root.
 * @param {string} cwd
 * @returns {Promise<string|null>} resolved absolute repo root, or null if none found
 */
export async function resolveRepoRoot(cwd) {
  if (!cwd) return null;
  let dir = await realpath(resolve(cwd)).catch(() => resolve(cwd));
  for (;;) {
    try {
      await access(resolve(dir, '.git'));
      return await realpath(dir).catch(() => dir);
    } catch {
      // not a git root — keep walking
    }
    // package.json marker for non-git folders
    try {
      await access(resolve(dir, 'package.json'));
      const parent = dirname(dir);
      if (parent !== dir) {
        const hasGitAbove = await hasGitAncestor(parent);
        if (!hasGitAbove) return await realpath(dir).catch(() => dir);
      }
    } catch {
      /* not a package root either */
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
      /* continue */
    }
    const parent = dirname(d);
    if (parent === d) return false;
    d = parent;
  }
}

/**
 * Resolve a CBM project for a repository root. Returns the indexed project
 * name, auto-indexing (mode: fast) if the repo hasn't been indexed yet.
 *
 * Matching is by exact root_path (after realpath), which is robust to the
 * derived-name slug differences between repos.
 *
 * @param {string} repoRoot  absolute repo root
 * @param {object} opts { signal? }
 * @returns {Promise<string>} CBM project name
 */
export async function resolveProjectForRoot(repoRoot, opts = {}) {
  if (!repoRoot)
    throw new Error('Could not determine repository root from cwd.');
  const root = await realpath(repoRoot).catch(() => repoRoot);
  const indexMode = opts.indexMode || 'fast';

  // 1. Look for an existing project by exact/canonical root_path match.
  const listed = await cbm('list_projects', {}, opts);
  const projects = Array.isArray(listed.projects) ? listed.projects : [];
  if (projects.length === 0) {
    // Not indexed yet → index once.
    const res = await cbm(
      'index_repository',
      { repo_path: root, mode: indexMode },
      opts,
    );
    const project = res?.project || res?.name;
    if (!project)
      throw new Error(
        `Indexed but could not determine project name: ${res?._stdout || JSON.stringify(res)}`,
      );
    return project;
  }

  // Canonicalize root_paths lazily (async) and match against `root`.
  const canonical = await Promise.all(
    projects.map(async (p) => ({
      name: p?.name,
      rp: p?.root_path
        ? await realpath(p.root_path).catch(() => p.root_path)
        : null,
    })),
  );
  const hit = canonical.find((c) => c.rp === root);
  if (hit) return hit.name;

  // 2. Not found → auto-index once (indexMode), then confirm.
  const res = await cbm(
    'index_repository',
    { repo_path: root, mode: indexMode },
    opts,
  );
  const project = res?.project || res?.name;
  if (!project)
    throw new Error(
      `Indexed but could not determine project name: ${res?._stdout || JSON.stringify(res)}`,
    );
  return project;
}

// --- Tool-facing helpers ---

/**
 * Convenience guard for tool.execute: ensure the CBM binary is available
 * (auto-installing if enabled by settings), returning an error-result object
 * to short-circuit when missing.
 *
 * @param {object} ctx  execute ctx (has .extensionSettings when wrapped)
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true }|{ ok: false, content: Array }>}
 */
export async function ensureBinaryOrError(ctx = {}, signal) {
  try {
    await ensureBinary(ctx?.extensionSettings || {}, { signal });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      content: [{ type: 'text', text: `Error: ${e.message}` }],
    };
  }
}

/**
 * Resolve the project to query for a tool call, using ctx.cwd to find the repo.
 * Accepts an explicit `project` override if the caller already knows the name.
 * @param {{project?: string, cwd?: string}} params
 * @param {object} ctx  tool execution context (has .cwd)
 * @param {object} opts
 * @returns {Promise<string>} CBM project name
 */
export async function resolveProject(params = {}, ctx = {}, opts = {}) {
  if (params.project) return params.project;
  const cwd = params.cwd || ctx?.cwd || process.cwd();
  const root = await resolveRepoRoot(cwd);
  return resolveProjectForRoot(root, opts);
}

/**
 * Build a user-facing error result when a project can't be resolved yet.
 */
export function notIndexedError(message) {
  return {
    content: [
      {
        type: 'text',
        text:
          message ||
          'No indexed project and no repository root detected from the working directory.\n' +
            'Ensure you are working inside a git repo, or pass an explicit `project` / `cwd` argument.',
      },
    ],
  };
}

// --- Settings-aware opts builder ---

/**
 * Build CBM opts from ezcode extension settings (injected into ctx.extensionSettings
 * by the registry wrapper). Respects per-tool override passed by the caller.
 *
 * @param {object} ctx  tool execute ctx (has .extensionSettings when wrapped)
 * @param {object} base  manual opts (signal, timeoutMs) — these win over settings
 * @returns {{ bin?: string, indexMode?: string, timeoutMs?: number, signal?: AbortSignal }}
 */
export function settingsOpts(ctx = {}, base = {}) {
  const s = ctx?.extensionSettings || {};
  const opts = { ...base };
  if (s.cbm_bin) opts.bin = s.cbm_bin;
  if (s.auto_index_mode) opts.indexMode = s.auto_index_mode;
  if (s.query_timeout_ms) opts.timeoutMs = Number(s.query_timeout_ms);
  return opts;
}
