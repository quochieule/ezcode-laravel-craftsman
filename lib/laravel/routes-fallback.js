/**
 * routes-fallback.js — parse routes/web.php + api.php khi `php artisan
 * route:list` không chạy được (repo boot lỗi: thiếu .env, vendor hỏng...).
 *
 * Degraded mode: không có middleware/domain chính xác 100%, nhưng URI + method
 * + controller@method là đủ để contract matching.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Parse 1 file routes PHP → mảng route {method, uri, name, action, middleware: []}. */
export function parseRoutesFile(content) {
  const routes = [];
  const re =
    /Route::(get|post|put|patch|delete|options|any|match|resource|apiResource|controller)\s*\(/g;
  let m;
  while ((m = re.exec(content))) {
    const kind = m[1];
    const chunk = content.slice(m.index, m.index + 600);
    if (kind === 'resource' || kind === 'apiResource') {
      const uri = /\(\s*['"]([^'"]+)['"]/.exec(chunk)?.[1];
      if (!uri) continue;
      for (const action of [
        'index',
        'create',
        'store',
        'show',
        'edit',
        'update',
        'destroy',
      ]) {
        routes.push({
          method:
            kind === 'apiResource' ||
            action === 'store' ||
            action === 'update' ||
            action === 'destroy'
              ? 'POST|PUT|DELETE'
              : 'GET|HEAD',
          uri: `${uri}/${action === 'index' ? '' : action}`.replace(/\/$/, ''),
          name: null,
          action: `resource:${uri}@${action}`,
          middleware: [],
        });
      }
      continue;
    }
    const uriMatch = /\(\s*['"]([^'"]+)['"]/.exec(chunk);
    if (!uriMatch) continue;
    const uri = uriMatch[1].replace(/^\//, '');
    let method = kind.toUpperCase();
    if (kind === 'match') {
      const mm = /match\s*\(\s*\[([^\]]*)\]/.exec(chunk);
      const methods = mm
        ? Array.from(mm[1].matchAll(/['"]([\w]+)['"]/g), (x) =>
            x[1].toUpperCase(),
          )
        : [method];
      method = methods.join('|');
    }
    if (kind === 'any') {
      method = 'ANY';
    }
    const name = /->\s*name\s*\(\s*['"]([^'"]+)['"]/.exec(chunk)?.[1] || null;
    const action =
      /->\s*(?:uses\s*\(\s*)?['"]([A-Za-z\\]+Controller@[\w]+)['"]/.exec(
        chunk,
      )?.[1] ||
      /use\s+([A-Za-z\\]+Controller::class)['"]?/.exec(chunk)?.[1] ||
      (kind === 'controller' ? 'controller-group' : 'closure');
    routes.push({ method, uri, name, action, middleware: [] });
  }
  return routes;
}

/** Load routes fallback từ web.php + api.php. */
export async function loadRoutesFallback(cwd) {
  const out = [];
  for (const file of ['routes/web.php', 'routes/api.php']) {
    const content = await readFile(join(cwd, file), 'utf8').catch(() => '');
    if (content.trim()) out.push(...parseRoutesFile(content));
  }
  return out;
}
