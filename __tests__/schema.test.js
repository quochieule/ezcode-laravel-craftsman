import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseMigration, scanMigrations } from '../lib/laravel/schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(
  here,
  'fixtures',
  'laravel-app',
  'database',
  'migrations',
);

test('parseMigration: bảng orders + cột + enum + FK', async () => {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(
    join(migrationsDir, '2024_01_01_000001_create_orders_table.php'),
    'utf8',
  );
  const parsed = parseMigration(content, 'create_orders.php');

  assert.deepEqual(parsed.creates, ['orders']);
  const cols = parsed.columns['orders'].map((c) => c.name);
  assert.ok(cols.includes('id'));
  assert.ok(cols.includes('user_id'));
  assert.ok(cols.includes('order_number'));
  assert.ok(cols.includes('status'));

  const status = parsed.columns['orders'].find((c) => c.name === 'status');
  assert.equal(status.type, 'enum');
  assert.deepEqual(parsed.enums['orders'].status, [
    'pending',
    'approved',
    'cancelled',
  ]);

  const fk = parsed.fks.find((f) => f.column === 'user_id');
  assert.equal(fk.references, 'users.id');
});

test('parseMigration: Schema::table thêm cột (alter)', async () => {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(
    join(migrationsDir, '2024_01_02_000002_add_shipping_to_orders.php'),
    'utf8',
  );
  const parsed = parseMigration(content, 'add_shipping.php');
  // up() + down() đều có Schema::table — chấp nhận 2 lần, chỉ cần đúng tên bảng
  assert.ok(parsed.alters.includes('orders'));
  assert.equal(parsed.alters.length, 2);
  const cols = parsed.columns['orders'].map((c) => c.name);
  assert.ok(cols.includes('shipping_address'));
  assert.ok(cols.includes('approved_at'));
  const ship = parsed.columns['orders'].find(
    (c) => c.name === 'shipping_address',
  );
  assert.equal(ship.nullable, true);
});

test('scanMigrations: gộp create + alter thành 1 bảng đầy đủ', async () => {
  const schema = await scanMigrations(migrationsDir);
  assert.ok(schema.order.includes('users'));
  assert.ok(schema.order.includes('orders'));

  const orders = schema.tables['orders'];
  assert.ok(orders);
  assert.ok(orders.createdBy.includes('create_orders'));
  assert.ok(orders.alteredBy.some((f) => f.includes('add_shipping')));
  // cột từ cả 2 migration
  const names = orders.columns.map((c) => c.name);
  assert.ok(names.includes('order_number'));
  assert.ok(names.includes('shipping_address'));
  assert.ok(names.includes('approved_at'));
  // enum giữ nguyên
  assert.deepEqual(orders.enums.status, ['pending', 'approved', 'cancelled']);
  // FK gộp
  assert.ok(
    schema.fks.some(
      (f) => f.column === 'user_id' && f.references === 'users.id',
    ),
  );
});

test('scanMigrations: thư mục không tồn tại → rỗng, không throw', async () => {
  const schema = await scanMigrations(join(here, 'fixtures', 'no-such-dir'));
  assert.deepEqual(schema, { tables: {}, order: [], files: [], fks: [] });
});
