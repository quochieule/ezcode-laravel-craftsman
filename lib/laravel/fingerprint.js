/**
 * Fingerprint — chân dung dự án Laravel: version, packages, conventions.
 *
 * Toàn bộ deterministic: đọc composer.json + artisan about + scan cấu trúc.
 * Agent được inject bản tóm tắt này vào đầu phiên → "thuộc" dự án từ giây đầu,
 * không phải mò từng thứ.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runArtisan } from '../exec.js';

/** Đọc composer.json → { name, laravelVersion, packages[], devPackages[] } */
export async function readComposer(cwd) {
  try {
    const raw = await readFile(join(cwd, 'composer.json'), 'utf8');
    const c = JSON.parse(raw);
    const req = c.require || {};
    const dev = c['require-dev'] || {};
    return {
      name: c.name || null,
      laravelVersion: req['laravel/framework'] || null,
      php: req.php || null,
      packages: Object.keys(req).sort(),
      devPackages: Object.keys(dev).sort(),
    };
  } catch {
    return {
      name: null,
      laravelVersion: null,
      php: null,
      packages: [],
      devPackages: [],
    };
  }
}

/** Đếm số file theo pattern trong 1 thư mục (đệ quy, giới hạn depth). */
async function countFiles(dir, depth = 4, limit = 500) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let n = 0;
    for (const e of entries) {
      if (n >= limit) return n;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'vendor') continue;
        if (depth > 0) n += await countFiles(p, depth - 1, limit - n);
      } else if (e.name.endsWith('.php')) {
        n++;
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** Đếm tần suất pattern log/error-handling trong 1 thư mục. */
async function countPattern(dir, patterns, depth = 4) {
  const counts = Object.fromEntries(patterns.map((p) => [p, 0]));
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (counts[patterns[0]] > 2000) break;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'vendor') continue;
        if (depth > 0) {
          const sub = await countPattern(p, patterns, depth - 1);
          for (const k of patterns) counts[k] += sub[k];
        }
      } else if (e.name.endsWith('.php')) {
        const content = await readFile(p, 'utf8').catch(() => '');
        for (const k of patterns) {
          // escape ký tự đặc biệt — pattern có thể chứa ( : : (activity(, Log::)
          const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`\\b${escaped}`, 'g');
          counts[k] += (content.match(re) || []).length;
        }
      }
    }
  } catch {
    /* bỏ qua thư mục lỗi */
  }
  return counts;
}

/**
 * Phát hiện conventions từ cấu trúc repo (không cần chạy app).
 * @returns {Promise<object>}
 */
export async function detectConventions(cwd) {
  const app = join(cwd, 'app');
  const exists = (p) =>
    stat(p)
      .then(() => true)
      .catch(() => false);

  const [
    hasRequests,
    hasServices,
    hasRepos,
    hasPolicies,
    hasObservers,
    hasEvents,
    hasJobs,
    hasApiResources,
    hasMail,
    hasNotifications,
    hasBladeLayouts,
    controllers,
    models,
    tests,
    logPatterns,
  ] = await Promise.all([
    exists(join(app, 'Http', 'Requests')),
    exists(join(app, 'Services')),
    exists(join(app, 'Repositories')),
    exists(join(app, 'Policies')),
    exists(join(app, 'Observers')),
    exists(join(app, 'Events')),
    exists(join(app, 'Jobs')),
    exists(join(app, 'Http', 'Resources')),
    exists(join(app, 'Mail')),
    exists(join(app, 'Notifications')),
    exists(join(cwd, 'resources', 'views', 'layouts')),
    countFiles(join(app, 'Http', 'Controllers')),
    countFiles(join(app, 'Models')),
    countFiles(join(cwd, 'tests')),
    countPattern(join(app, 'Http', 'Controllers'), [
      'Log::',
      'logger(',
      'activity(',
    ]),
  ]);

  const hasPest = await exists(join(cwd, 'tests', 'Pest.php'));
  const composer = await readComposer(cwd);

  // Frontend conventions — đệ quy để lấy cả file trong thư mục con (public/js/admin/...)
  const { scanJsFiles } = await import('./frontend/js-extract.js');
  const publicJs = await scanJsFiles(join(cwd, 'public', 'js'), 3, 30);
  const hasResourcesJs = await exists(join(cwd, 'resources', 'js'));
  // normalize path về forward-slash rồi mới cắt prefix (Windows-safe)
  const jsPrefix = join(cwd, 'public', 'js').replace(/\\/g, '/') + '/';
  const relPublicJs = publicJs.map((p) =>
    p.replace(/\\/g, '/').replace(jsPrefix, ''),
  );

  return {
    controllers: {
      count: controllers,
      services: hasServices,
      repositories: hasRepos,
    },
    models: { count: models },
    validation: hasRequests ? 'FormRequest' : 'inline',
    auth: {
      sanctum: composer.packages.includes('laravel/sanctum'),
      passport: composer.packages.includes('laravel/passport'),
      policies: hasPolicies,
    },
    patterns: {
      events: hasEvents,
      jobs: hasJobs,
      observers: hasObservers,
      apiResources: hasApiResources,
      mail: hasMail,
      notifications: hasNotifications,
    },
    tests: {
      framework: hasPest ? 'Pest' : 'PHPUnit',
      files: tests,
    },
    logging: logPatterns,
    frontend: {
      jsFiles: relPublicJs.slice(0, 20),
      resourcesJs: hasResourcesJs,
      bladeLayouts: hasBladeLayouts,
    },
  };
}

/**
 * Build fingerprint đầy đủ cho 1 repo.
 * @param {string} cwd
 * @param {object} opts { phpBin?, timeoutMs?, signal? }
 * @returns {Promise<{composer:object, about:object|null, conventions:object, at:string}>}
 */
export async function buildFingerprint(cwd, opts = {}) {
  const [composer, conventions] = await Promise.all([
    readComposer(cwd),
    detectConventions(cwd),
  ]);

  // artisan about — lấy version + environment thật (có thể fail nếu app hỏng → không chặn)
  let about = null;
  try {
    const raw = await runArtisan(cwd, ['about', '--json'], opts);
    const parsed = JSON.parse(raw);
    about = {
      version: parsed['Laravel Version'] || parsed.laravel_version || null,
      // Laravel 10: key 'environment' (object) · Laravel 12: 'Environment' — xử lý cả 2
      environment: (() => {
        const raw = parsed['Environment'] ?? parsed.environment;
        return raw && typeof raw === 'object'
          ? JSON.stringify(raw)
          : raw || null;
      })(),
      cache: parsed['Cache'] || null,
      session: parsed['Session'] || null,
      queue: parsed['Queue'] || null,
    };
  } catch {
    /* artisan about không chạy được — bỏ qua */
  }

  return { composer, about, conventions, at: new Date().toISOString() };
}

/** Render fingerprint gọn cho agent (≤ ~600 token). */
export function renderFingerprint(fp) {
  const { composer, about, conventions: c } = fp;
  const lines = [];
  if (composer.name) lines.push(`Project: ${composer.name}`);
  const ver = about?.version || composer.laravelVersion || '?';
  lines.push(
    `Laravel: ${ver} · PHP: ${composer.php || '?'} · env: ${about?.environment || '?'}`,
  );
  lines.push(
    `Queue: ${about?.queue || 'sync?'} · Cache: ${about?.cache || '?'} · Session: ${about?.session || '?'}`,
  );

  const keyPackages = composer.packages.filter((p) =>
    /sanctum|passport|spatie|pest|telescope|debugbar|activity|audit|filament|nova|inertia|livewire|jetstream|fortify|horizon|scout|tinker/i.test(
      p,
    ),
  );
  if (keyPackages.length) lines.push(`Key packages: ${keyPackages.join(', ')}`);

  lines.push(
    `Structure: ${c.controllers?.count ?? 0} controllers · ${c.models?.count ?? 0} models` +
      (c.controllers?.services ? ' · Services layer ✓' : '') +
      (c.controllers?.repositories ? ' · Repositories ✓' : '') +
      ` · Validation: ${c.validation}`,
  );
  lines.push(
    `Auth: ${c.auth.sanctum ? 'Sanctum' : c.auth.passport ? 'Passport' : 'session'}${c.auth.policies ? ' + Policies' : ''}`,
  );
  lines.push(
    `Patterns: ${
      [
        c.patterns.events && 'events',
        c.patterns.jobs && 'jobs',
        c.patterns.observers && 'observers',
        c.patterns.apiResources && 'API resources',
        c.patterns.mail && 'mail',
        c.patterns.notifications && 'notifications',
      ]
        .filter(Boolean)
        .join(', ') || 'không có gì đặc biệt'
    }`,
  );
  const logStyle = Object.entries(c.logging || {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}×${n}`)
    .join(' · ');
  lines.push(
    `Logging (controller scan): ${logStyle || 'không thấy pattern log'}`,
  );
  lines.push(
    `Tests: ${c.tests?.framework || '?'} (${c.tests?.files ?? 0} files)`,
  );
  if (c.frontend?.jsFiles?.length)
    lines.push(`public/js: ${c.frontend.jsFiles.join(', ')}`);
  if (c.frontend?.bladeLayouts)
    lines.push('Blade layouts: resources/views/layouts ✓');

  return lines.join('\n');
}
