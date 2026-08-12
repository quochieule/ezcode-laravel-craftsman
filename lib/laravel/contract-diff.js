/**
 * contract-diff.js — ★ cross-layer set-diff (đặc tả §6.7).
 *
 * So field/key names giữa các tầng của 1 feature:
 *   Blade inputs ↔ JS $.ajax data ↔ FormRequest rules ↔ Controller $request
 * Mismatch = 🔴 blocking — thứ model không bao giờ tự nhớ nổi ở codebase lớn.
 *
 * v1: trích theo nguồn — blade (name=), JS (data keys), FormRequest (rules keys),
 * controller ($request->input/get/validate keys). Deterministic 100%.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Trích field names từ blade: name="x" trong input/select/textarea. */
export function extractBladeFields(content) {
  const out = new Set();
  let m;
  const re =
    /<(?:input|select|textarea|button)\b[^>]*\bname\s*=\s*(["'])([^"']+)\1/gi;
  while ((m = re.exec(content))) {
    const name = m[2].trim();
    // bỏ dạng động {{ ... }} / array[]
    if (name.startsWith('{{') || name.startsWith('$')) continue;
    out.add(name.replace(/\[\]$/, ''));
  }
  return out;
}

/** Trích keys từ JS: data: {a: 1, b}, $.ajax data object, serializeArray fields. */
export function extractJsDataKeys(js) {
  const out = new Set();
  let m;
  // data: { key: value, ... }
  const re = /\bdata\s*:\s*\{([^}]*)\}/g;
  while ((m = re.exec(js))) {
    const body = m[1];
    for (const key of body.matchAll(/(['"])?([A-Za-z_][\w]*)\1\s*:/g)) {
      out.add(key[2]);
    }
  }
  // $('form').serialize() — field names từ form, không trích được → bỏ qua
  return out;
}

/** Trích keys từ FormRequest rules: 'field' => [...]. */
export function extractRequestRules(content) {
  const out = new Set();
  let m;
  const re = /(['"])([A-Za-z_][\w.]*)\1\s*=>/g;
  while ((m = re.exec(content))) out.add(m[2].split('.')[0]);
  return out;
}

/** Trích keys từ controller: $request->input('x') / ->get('x') / ->validate([...]) / $request->x. */
export function extractControllerRequestKeys(content) {
  const out = new Set();
  let m;
  const re =
    /\$request\s*->\s*(?:input|get|post|string|integer|boolean|validate)\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = re.exec(content))) out.add(m[1]);
  const re2 = /\$request\s*->\s*([A-Za-z_][\w]*)/g;
  while ((m = re2.exec(content))) {
    if (
      ![
        'input',
        'get',
        'post',
        'validate',
        'all',
        'only',
        'except',
        'user',
        'route',
        'has',
        'filled',
        'exists',
        'method',
        'is',
        'wantsJson',
      ].includes(m[1])
    ) {
      out.add(m[1]);
    }
  }
  return out;
}

/**
 * Diff đầy đủ giữa các tầng.
 * @param {object} input { bladeHtml:string, jsText:string, requestRulesText:string, controllerText:string }
 * @returns {{blade:Set, js:Set, rules:Set, controller:Set, mismatches:Array<{between:string, key:string}>}}
 */
export function contractDiff({
  bladeHtml = '',
  jsText = '',
  requestRulesText = '',
  controllerText = '',
}) {
  const blade = extractBladeFields(bladeHtml);
  const js = extractJsDataKeys(jsText);
  const rules = extractRequestRules(requestRulesText);
  const controller = extractControllerRequestKeys(controllerText);

  const mismatches = [];
  // JS gửi field không có trong rules (nếu rules tồn tại và khác rỗng)
  if (rules.size > 0) {
    for (const k of js) {
      if (!rules.has(k)) mismatches.push({ between: 'JS→FormRequest', key: k });
    }
    for (const k of blade) {
      if (!rules.has(k))
        mismatches.push({ between: 'Blade→FormRequest', key: k });
    }
  }
  // Controller đọc field không có trong blade (form thường phải có)
  for (const k of controller) {
    if (blade.size > 0 && !blade.has(k))
      mismatches.push({ between: 'Controller→Blade', key: k });
  }
  return { blade, js, rules, controller, mismatches };
}

/** Render diff gọn. */
export function renderContractDiff(diff) {
  if (!diff.mismatches.length)
    return 'Contract diff: ✓ khớp giữa blade ↔ JS ↔ FormRequest ↔ controller.';
  const lines = ['🔴 Contract mismatch:'];
  for (const m of diff.mismatches) {
    lines.push(`  - ${m.between}: "${m.key}" không khớp`);
  }
  lines.push(
    `  (blade fields: ${[...diff.blade].join(', ') || '∅'} · js data keys: ${[...diff.js].join(', ') || '∅'}` +
      ` · rules: ${[...diff.rules].join(', ') || '∅'} · controller reads: ${[...diff.controller].join(', ') || '∅'})`,
  );
  return lines.join('\n');
}

/** Đọc text của các file liên quan rồi diff (cho tool/plan dùng). */
export async function diffFromFiles(
  root,
  {
    bladeFiles = [],
    jsFiles = [],
    requestFiles = [],
    controllerFiles = [],
  } = {},
) {
  const read = async (p) => readFile(join(root, p), 'utf8').catch(() => '');
  const [bladeHtml, jsText, requestRulesText, controllerText] =
    await Promise.all([
      Promise.all(bladeFiles.map(read)).then((a) => a.join('\n')),
      Promise.all(jsFiles.map(read)).then((a) => a.join('\n')),
      Promise.all(requestFiles.map(read)).then((a) => a.join('\n')),
      Promise.all(controllerFiles.map(read)).then((a) => a.join('\n')),
    ]);
  return contractDiff({ bladeHtml, jsText, requestRulesText, controllerText });
}
