/**
 * laravel_schema — bản đồ database từ migrations (deterministic, không cần DB).
 */
import { scanMigrations, renderSchema } from '../lib/laravel/schema.js';
import { resolveRootOrError, isLaravelRepo } from '../lib/context.js';
import { join } from 'node:path';

export default {
  name: 'laravel_schema',
  label: 'Laravel Schema',
  description:
    'Bản đồ database hiện tại từ database/migrations: bảng, cột, kiểu, nullable, enum values, ' +
    'khóa ngoại. Deterministic (đọc file migration, không cần DB chạy). Dùng trước khi thêm/sửa ' +
    'migration, model, relationship — để biết schema thật, không đoán.',
  parameters: {
    type: 'object',
    properties: {
      table: {
        type: 'string',
        description: 'Optional — chỉ hiển thị 1 bảng (vd "orders").',
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory override.',
      },
    },
  },
  promptSnippet: 'laravel_schema(table?) — bảng/cột/enum/FK thật từ migrations',
  promptGuidelines: [
    'Trước khi thêm cột/bảng/quan hệ: gọi laravel_schema để xem schema thật đã có gì.',
    'Enum values phải đối chiếu với schema (vd status=[pending|approved|cancelled]) — không tự bịa giá trị enum.',
  ],

  async execute(_id, params, _signal, _onUpdate, ctx) {
    const resolved = await resolveRootOrError(params, ctx);
    if (!resolved.ok) return resolved;
    const root = resolved.root;

    if (!(await isLaravelRepo(root))) {
      return {
        content: [{ type: 'text', text: `"${root}" không phải repo Laravel.` }],
      };
    }

    try {
      const schema = await scanMigrations(join(root, 'database', 'migrations'));
      if (params.table) {
        const t = schema.tables[params.table];
        if (!t) {
          return {
            content: [
              {
                type: 'text',
                text: `Không có bảng "${params.table}". Các bảng: ${schema.order.join(', ') || '(trống)'}`,
              },
            ],
          };
        }
        const cols = t.columns
          .map(
            (c) => `- ${c.name}: ${c.type}${c.nullable ? ' (nullable)' : ''}`,
          )
          .join('\n');
        const enums = Object.entries(t.enums)
          .map(([k, v]) => `- ${k}: [${v.join(' | ')}]`)
          .join('\n');
        return {
          content: [
            {
              type: 'text',
              text: `Bảng "${params.table}" (tạo từ ${t.createdBy}${t.alteredBy.length ? `, alter: ${t.alteredBy.join(', ')}` : ''}):\n${cols}\n${enums ? `\nEnums:\n${enums}` : ''}`,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: renderSchema(schema) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Lỗi: ${e.message}` }] };
    }
  },
};
