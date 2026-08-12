import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import entryFactory from '../index.js';
import {
  addEpisode,
  recentEpisodes,
  addLearnedCheck,
  learnedChecks,
  saveKnowledge,
  recallKnowledge,
} from '../lib/memory.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

function stubPi(settings = {}) {
  const tools = [];
  const events = [];
  const pi = {
    registerTool: (t) => tools.push(t),
    on: (ev, h) => events.push({ ev, h }),
    settings: { all: () => settings },
    createModelsCollection: () => ({
      getModel: () => null,
      completeSimple: async () => ({}),
    }),
    setPanelSchema: () => {},
    publishToSession: () => {},
    sendUserMessage: () => {},
  };
  return { pi, tools, events };
}

test('index.js v0.2: register đủ 7 tools', () => {
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
});

test('index.js v0.2: wire 3 events (input/tool_call/agent_end)', () => {
  const { pi, events } = stubPi();
  entryFactory(pi);
  const evs = events.map((e) => e.ev);
  assert.ok(evs.includes('input'));
  assert.ok(evs.includes('tool_call'));
  assert.ok(evs.includes('agent_end'));
});

test('input event: prompt phức tạp bị transform ép dùng laravel_plan', async () => {
  const { pi, events } = stubPi();
  entryFactory(pi);
  const inputHandler = events.find((e) => e.ev === 'input').h;
  const res = await inputHandler(
    { text: 'thêm nút duyệt đơn cho admin, xong gửi mail cho khách' },
    { sessionId: 's1', cwd: appRoot },
  );
  assert.ok(res, 'phải transform');
  assert.ok(res.text.includes('laravel_plan'));
  // prompt do chính mình transform → không lặp
  const res2 = await inputHandler(
    { text: res.text },
    { sessionId: 's1', cwd: appRoot },
  );
  assert.equal(res2, undefined);
});

test('input event: trivial → không can thiệp; question → answer-mode', async () => {
  const { pi, events } = stubPi();
  entryFactory(pi);
  const inputHandler = events.find((e) => e.ev === 'input').h;
  assert.equal(
    await inputHandler(
      { text: 'đổi màu nút' },
      { sessionId: 's1', cwd: appRoot },
    ),
    undefined,
  );
  const q = await inputHandler(
    { text: 'Hệ thống phân quyền thế nào?' },
    { sessionId: 's1', cwd: appRoot },
  );
  assert.ok(q, 'question phải được transform sang answer-mode');
  assert.ok(q.text.includes('laravel_fingerprint'));
});

test('tool_call gate: chặn edit khi chưa plan (strict mode)', async () => {
  const { pi, events } = stubPi({ strict_mode: 'true' });
  entryFactory(pi);
  const inputHandler = events.find((e) => e.ev === 'input').h;
  const gateHandler = events.find((e) => e.ev === 'tool_call').h;

  await inputHandler(
    { text: 'thêm nút duyệt đơn, gửi mail' },
    { sessionId: 's2', cwd: appRoot },
  );

  const blocked = await gateHandler(
    { toolName: 'edit' },
    { sessionId: 's2', cwd: appRoot },
  );
  assert.ok(blocked?.block === true);
  assert.ok(blocked.reason.includes('laravel_plan'));

  await gateHandler(
    { toolName: 'laravel_plan' },
    { sessionId: 's2', cwd: appRoot },
  );
  const allowed = await gateHandler(
    { toolName: 'edit' },
    { sessionId: 's2', cwd: appRoot },
  );
  assert.equal(allowed, undefined);

  const readOk = await gateHandler(
    { toolName: 'read' },
    { sessionId: 's3', cwd: appRoot },
  );
  assert.equal(readOk, undefined);
});

test('tool_call gate: strict_mode off → không chặn', async () => {
  const { pi, events } = stubPi({ strict_mode: 'false' });
  entryFactory(pi);
  const inputHandler = events.find((e) => e.ev === 'input').h;
  const gateHandler = events.find((e) => e.ev === 'tool_call').h;
  await inputHandler(
    { text: 'thêm nút duyệt đơn, gửi mail' },
    { sessionId: 's4', cwd: appRoot },
  );
  assert.equal(
    await gateHandler({ toolName: 'edit' }, { sessionId: 's4', cwd: appRoot }),
    undefined,
  );
});

test('agent_end: auto-RVP không crash khi thiếu model', async () => {
  const { pi, events } = stubPi();
  entryFactory(pi);
  const endHandler = events.find((e) => e.ev === 'agent_end').h;
  const res = await endHandler({}, { sessionId: 's5', cwd: appRoot });
  assert.equal(res, undefined);
});

test('memory: episodes + learned checks + knowledge (append + đọc lại)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'craftsman-test-'));
  try {
    await addEpisode(dir, {
      task: 'fix login',
      filesRead: ['a.php'],
      planFiles: ['b.php'],
      score: 0.8,
    });
    await addEpisode(dir, {
      task: 'thêm endpoint',
      filesRead: ['c.php'],
      planFiles: [],
      score: 0.9,
    });
    const eps = await recentEpisodes(dir, 10);
    assert.equal(eps.length, 2);
    assert.equal(eps[0].task, 'thêm endpoint');

    await addLearnedCheck(dir, {
      trigger: 'user tìm ra lỗi',
      check: 'luôn check guard test',
      source: 'rvp',
    });
    await addLearnedCheck(dir, {
      trigger: 'user tìm ra lỗi',
      check: 'luôn check guard test',
      source: 'rvp',
    });
    const checks = await learnedChecks(dir);
    assert.equal(checks.length, 1);

    await saveKnowledge(dir, {
      kind: 'decision',
      content: 'admin actions log bằng activity()',
      source: 'user',
    });
    const found = await recallKnowledge(dir, 'activity');
    assert.equal(found.length, 1);
    const none = await recallKnowledge(dir, 'không-có-gì');
    assert.equal(none.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
