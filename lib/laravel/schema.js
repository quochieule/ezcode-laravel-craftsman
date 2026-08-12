/**
 * Schema — bản đồ database từ migrations (deterministic, không cần DB chạy).
 *
 * Đọc database/migrations/*.php, extract:
 *   - bảng: Schema::create('name') / Schema::table('name') (alter)
 *   - cột: $table-><type>('col', ...) + nullable
 *   - khóa ngoại: ->constrained() / ->references('x')->on('y')
 *   - enum values: $table->enum('status', ['a','b'])
 *
 * Regex-based là chủ ý: migrations là PHP có cấu trúc đều, regex đủ chính xác
 * và không cần parse PHP thật. Mọi hàm parse đều pure — test được.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Các type cột Eloquent schema builder (đủ cho 99% migration)
const COL_TYPES = [
  'string',
  'char',
  'text',
  'mediumText',
  'longText',
  'integer',
  'tinyInteger',
  'smallInteger',
  'mediumInteger',
  'bigInteger',
  'unsignedInteger',
  'unsignedBigInteger',
  'unsignedTinyInteger',
  'unsignedSmallInteger',
  'unsignedMediumInteger',
  'float',
  'double',
  'decimal',
  'unsignedDecimal',
  'boolean',
  'date',
  'dateTime',
  'dateTimeTz',
  'time',
  'timestamp',
  'timestampTz',
  'year',
  'json',
  'jsonb',
  'binary',
  'uuid',
  'ulid',
  'ipAddress',
  'macAddress',
  'enum',
  'set',
  'foreignId',
  'foreignUuid',
  'foreignUlid',
  'rememberToken',
  'softDeletes',
  'timestamps',
  'nullableMorphs',
  'morphs',
];

const TYPE_RE = `(?:${COL_TYPES.join('|')})`;

function extractCalls(content, fnName) {
  const re = new RegExp(`Schema::${fnName}\\s*\\(\\s*['"]([\\w_]+)['"]`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(content))) out.push(m[1]);
  return out;
}

/** Tách 1 khối Schema::create / Schema::table để scan cột. */
function extractSchemaBlocks(content) {
  const blocks = [];
  const re =
    /Schema::(create|table)\s*\(\s*['"]([\w_]+)['"]\s*,\s*function\s*\(\s*(?:Blueprint\s+)?\$table\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(content))) {
    // tìm dấu } đóng khối (đếm ngoặc từ vị trí mở)
    const open = content.indexOf('{', m.index + m[0].length - 1);
    let depth = 0;
    let end = -1;
    for (let i = open; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > open) {
      blocks.push({
        kind: m[1],
        table: m[2],
        body: content.slice(open, end + 1),
      });
    }
  }
  return blocks;
}

/**
 * Parse 1 migration file.
 * @param {string} content
 * @param {string} filePath
 * @returns {{file:string, creates:Array, alters:Array, columns:object, fks:Array, enums:object}}
 *   columns: table → [{name,type,nullable}] · enums: table → {col: values}
 */
export function parseMigration(content, filePath = '') {
  const creates = extractCalls(content, 'create');
  const alters = extractCalls(content, 'table');
  const columns = {};
  const fks = [];
  const enumsByTable = {};

  for (const block of extractSchemaBlocks(content)) {
    const cols = [];
    const tableEnums = {};
    // $table->type('col'...) — không bắt ->dropColumn / ->index / ->foreign
    const colRe = new RegExp(
      `\\$table\\s*->\\s*(${TYPE_RE})\\s*\\(\\s*['"]([\\w_]+)['"]`,
      'g',
    );
    // Các method KHÔNG có tham số tên: id(), timestamps(), softDeletes(), rememberToken()
    const noArgRe =
      /\$table\s*->\s*(id|timestamps|softDeletes|rememberToken|ulid|uuid)\s*\(/g;
    let m;
    while ((m = colRe.exec(block.body))) {
      const [type, name] = [m[1], m[2]];
      if (
        type === 'foreignId' ||
        type === 'foreignUuid' ||
        type === 'foreignUlid'
      ) {
        // foreignId('user_id') ->constrained('users') hoặc ->references->on
        const after = block.body.slice(m.index, m.index + 200);
        const constrained =
          /->\s*constrained\s*\(\s*['"]?([\w_]+)?['"]?\s*\)/.exec(after);
        const refOn = /->\s*on\s*\(\s*['"]([\w_]+)['"]\s*\)/.exec(after);
        const refCol = /->\s*references\s*\(\s*['"]([\w_]+)['"]\s*\)/.exec(
          after,
        );
        const target =
          constrained?.[1] ||
          refOn?.[1] ||
          (name.endsWith('_id') ? name.slice(0, -3) : null);
        fks.push({
          column: name,
          references: target ? `${target}.${refCol?.[1] || 'id'}` : null,
        });
        cols.push({
          name,
          type: 'foreignId',
          nullable: /->\s*nullable\s*\(/.test(after),
        });
        continue;
      }
      const after = block.body.slice(m.index, m.index + 120);
      if (type === 'enum') {
        const vals = /->\s*enum\s*\(\s*['"][\w_]+['"]\s*,\s*\[([^\]]*)\]/.exec(
          after,
        );
        tableEnums[name] = vals
          ? Array.from(vals[1].matchAll(/['"]([^'"]+)['"]/g), (x) => x[1])
          : [];
      }
      cols.push({ name, type, nullable: /->\s*nullable\s*\(/.test(after) });
    }
    while ((m = noArgRe.exec(block.body))) {
      const name = m[1];
      if (name === 'timestamps') {
        cols.push({ name: 'created_at', type: 'timestamp', nullable: true });
        cols.push({ name: 'updated_at', type: 'timestamp', nullable: true });
      } else if (name === 'softDeletes') {
        cols.push({ name: 'deleted_at', type: 'timestamp', nullable: true });
      } else if (name === 'rememberToken') {
        cols.push({ name: 'remember_token', type: 'string', nullable: true });
      } else {
        cols.push({ name, type: name, nullable: false }); // id/uuid/ulid
      }
    }
    // up() + down() đều có Schema::table — phải MERGE, không ghi đè
    columns[block.table] = (columns[block.table] || []).concat(cols);
    if (Object.keys(tableEnums).length) {
      enumsByTable[block.table] = {
        ...(enumsByTable[block.table] || {}),
        ...tableEnums,
      };
    }
  }

  return { file: filePath, creates, alters, columns, fks, enums: enumsByTable };
}

/**
 * Scan toàn bộ migrations trong repo → bản đồ schema.
 * @param {string} migrationsDir  đường dẫn database/migrations
 * @returns {Promise<{tables:object, order:string[], files:string[], fks:Array}>}
 */
export async function scanMigrations(migrationsDir) {
  let files;
  try {
    files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.php'))
      .sort();
  } catch {
    return { tables: {}, order: [], files: [], fks: [] };
  }
  const tables = {};
  const order = [];
  const fks = [];
  for (const f of files) {
    const content = await readFile(join(migrationsDir, f), 'utf8');
    const parsed = parseMigration(content, f);
    for (const t of parsed.creates) {
      if (!tables[t]) {
        tables[t] = { columns: [], enums: {}, createdBy: f, alteredBy: [] };
        order.push(t);
      }
    }
    for (const t of Object.keys(parsed.columns)) {
      if (!tables[t] || !parsed.columns[t].length) continue;
      if (parsed.creates.includes(t)) {
        // file tạo bảng → gán cột gốc
        tables[t].columns = parsed.columns[t];
      } else {
        // file alter → MERGE từng cột chưa có (up+down đã gộp sẵn trong parseMigration)
        const existing = new Set(tables[t].columns.map((c) => c.name));
        for (const c of parsed.columns[t])
          if (!existing.has(c.name)) tables[t].columns.push(c);
        if (!tables[t].alteredBy.includes(f)) tables[t].alteredBy.push(f);
      }
    }
    for (const t of Object.keys(parsed.enums)) {
      if (tables[t])
        tables[t].enums = { ...(tables[t].enums || {}), ...parsed.enums[t] };
    }
    fks.push(...parsed.fks.map((fk) => ({ ...fk, file: f })));
  }
  return { tables, order, files, fks };
}

/** Render schema gọn cho agent. */
export function renderSchema(schema, maxTables = 40) {
  const { tables, order } = schema;
  const names = (order.length ? order : Object.keys(tables)).slice(
    0,
    maxTables,
  );
  if (!names.length)
    return 'Không có migration nào (database/migrations trống hoặc không tồn tại).';
  const lines = names.map((t) => {
    const tb = tables[t];
    if (!tb) return `- ${t}`;
    const cols = tb.columns
      .map((c) => `${c.name}:${c.type}${c.nullable ? '?' : ''}`)
      .join(', ');
    const enums = Object.entries(tb.enums)
      .map(([k, v]) => `${k}=[${v.join('|')}]`)
      .join(' ');
    return `- ${t} (${cols})${enums ? ` · ${enums}` : ''}`;
  });
  const more =
    names.length < Object.keys(tables).length
      ? `\n… (+${Object.keys(tables).length - names.length} tables)`
      : '';
  const fks = schema.fks.map((f) => `${f.column}→${f.references}`).join(', ');
  return lines.join('\n') + more + (fks ? `\nFK: ${fks}` : '');
}
