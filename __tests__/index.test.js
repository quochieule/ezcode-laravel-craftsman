import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import entryFactory from '../index.js';
import { isLaravelRepo, resolveRepoRoot } from '../lib/context.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

/** Stub pi — mô phỏng probe của extensionRegistry + runtime thật. */
function stubPi() {
  const tools = [];
  const events = [];
  const settings = { all: () => ({}) };
  return {
    pi: {
      registerTool: (t) => tools.push(t),
      on: (ev, h) => events.push({ ev, h }),
      settings,
      createModelsCollection: () => ({
        getModel: () => null,
        completeSimple: async () => ({}),
      }),
    },
    tools,
    events,
  };
}

test('index.js: probe-safe — register đủ 7 tools, không throw với stub pi', () => {
  const { pi, tools } = stubPi();
  entryFactory(pi);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'laravel_audit',
    'laravel_contracts',
    'laravel_fingerprint',
    'laravel_plan',
    'laravel_reverify',
    'laravel_schema',
    'laravel_trace_flow',
  ]);
  for (const t of tools) {
    assert.ok(t.description, `${t.name} thiếu description`);
    assert.ok(t.parameters?.type === 'object', `${t.name} thiếu parameters`);
    assert.equal(typeof t.execute, 'function', `${t.name} thiếu execute`);
  }
});

test('index.js: wrapper inject extensionSettings + createModelsCollection + background vào ctx', async () => {
  // patch module tool trước khi factory chạy — factory wrap execute tại thời điểm gọi
  const fingerprintTool = await import('../tools/laravel-fingerprint.js');
  const original = fingerprintTool.default.execute;
  let seenCtx = null;
  fingerprintTool.default.execute = async (_id, _p, _s, _u, ctx) => {
    seenCtx = ctx;
    return { content: [{ type: 'text', text: 'intercepted' }] };
  };
  try {
    const { pi, tools } = stubPi();
    entryFactory(pi);
    const wrapped = tools.find((t) => t.name === 'laravel_fingerprint');
    const res = await wrapped.execute('id', {}, undefined, undefined, {
      cwd: appRoot,
    });
    assert.ok(seenCtx, 'execute gốc phải được gọi qua wrapper');
    assert.deepEqual(seenCtx.extensionSettings, {});
    assert.equal(typeof seenCtx.createModelsCollection, 'function');
    assert.equal(typeof seenCtx.background, 'object', 'phải inject background manager');
    assert.equal(typeof seenCtx.background.start, 'function');
    assert.equal(typeof seenCtx.background.deliver, 'function');
    assert.equal(res.content[0].text, 'intercepted');
  } finally {
    fingerprintTool.default.execute = original;
  }
});

test('index.js: panel schema theo chuẩn schemaRenderer (root/defs) — KHÔNG dùng JSON-schema properties', () => {
  const panels = [];
  const pi = {
    registerTool: () => {},
    on: () => {},
    settings: { all: () => ({}) },
    createModelsCollection: () => null,
    setPanelSchema: (channel, panel) => panels.push({ channel, panel }),
  };
  entryFactory(pi);
  const craftsman = panels.find((p) => p.channel === 'laravel-craftsman');
  assert.ok(craftsman, 'phải đăng ký panel craftsman');
  const schema = craftsman.panel.schema;
  // Regression bug v0.2: {type:'object', properties} → renderer throw
  // UnknownNodeTypeError('object') (frontend/src/engine/schemaRenderer.js chỉ
  // có stack/inline/field/text/list/card/...). Phải có root + node type hợp lệ.
  assert.ok(schema.root, 'schema phải có root');
  assert.equal(schema.properties, undefined, 'KHÔNG được dùng JSON-schema properties');
  assert.ok(Array.isArray(schema.root.of), 'root phải là stack có of[]');
  // Field path của payload phải khớp: plan.* (background.js publish key `plan`)
  const s = JSON.stringify(schema);
  assert.ok(s.includes('plan.id'), 'schema phải tham chiếu plan.id');
  assert.ok(s.includes('plan.status'), 'schema phải tham chiếu plan.status');
  assert.ok(s.includes('plan.stage'), 'schema phải tham chiếu plan.stage');
  assert.ok(s.includes('lastTriage'), 'schema phải tham chiếu lastTriage');
  assert.ok(s.includes('episodes'), 'schema phải tham chiếu episodes');
});

test('context: resolveRepoRoot + isLaravelRepo trên fixture', async () => {
  const root = await resolveRepoRoot(appRoot);
  assert.ok(root);
  assert.equal(await isLaravelRepo(root), true);
  assert.equal(await isLaravelRepo(join(here, 'fixtures')), false);
});

test('tools chạy thật trên fixture: laravel_fingerprint + laravel_schema (deterministic, không cần artisan/LLM)', async () => {
  const { pi, tools } = stubPi();
  entryFactory(pi);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const fpRes = await byName['laravel_fingerprint'].execute(
    '1',
    { cwd: appRoot },
    undefined,
    undefined,
    { cwd: appRoot },
  );
  const fpText = fpRes.content[0].text;
  assert.ok(fpText.includes('Laravel: ^11.0') || fpText.includes('^11.0'));
  assert.ok(fpText.includes('Sanctum'));
  assert.ok(fpText.includes('FormRequest'));

  const schRes = await byName['laravel_schema'].execute(
    '2',
    { cwd: appRoot },
    undefined,
    undefined,
    { cwd: appRoot },
  );
  const schText = schRes.content[0].text;
  assert.ok(schText.includes('orders'));
  assert.ok(schText.includes('status'));
  assert.ok(schText.includes('pending|approved|cancelled'));
});

test('tools: repo không phải Laravel → báo rõ, không crash', async () => {
  const { pi, tools } = stubPi();
  entryFactory(pi);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const res = await byName['laravel_fingerprint'].execute(
    '1',
    { cwd: here },
    undefined,
    undefined,
    { cwd: here },
  );
  assert.ok(res.content[0].text.includes('không phải repo Laravel'));
});
