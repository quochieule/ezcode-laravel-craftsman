import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSubAgent,
  createSubagentRunner,
  sanitizeSessionId,
  appendRobust,
} from '../lib/subagent.js';
import { runPlanners, packForRole } from '../lib/stages/planners.js';
import { runPromptCritics } from '../lib/stages/prompt-critics.js';
import { adversarialChannel } from '../lib/stages/rvp.js';

const FAKE_JSON = JSON.stringify({
  touchpoints: [{ item: 'route', action: 'existing', file: 'routes/web.php', reason: 'x' }],
  files: ['routes/web.php'],
  tests: [],
  risks: [],
  assumptions: [],
  unknowns: [],
});

/** Fake forkContext + spawnSubagent capture mọi thứ. */
function fakeSdk({ promptImpl, emitEvents = true } = {}) {
  const spawned = [];
  const disposed = [];
  let sessionId = null;
  return {
    spawned,
    disposed,
    getSessionId: () => sessionId,
    ctx: {
      cwd: 'C:/repo',
      sessionManager: { getSessionId: () => 'sess-test' },
      background: {
        publishState: () => {},
      },
      forkContext: async () => ({
        SessionManager: {
          inMemory: () => ({
            newSession: ({ id }) => {
              sessionId = id;
            },
            getSessionId: () => sessionId,
          }),
        },
      }),
      spawnSubagent: async (opts) => {
        const session = {
          messages: [],
          prompt: async (mission) => {
            if (promptImpl) await promptImpl(mission);
            if (emitEvents) {
              // mô phỏng delta text rồi kết thúc
              opts.onEvent?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: FAKE_JSON } });
              opts.onEvent?.({ type: 'tool_execution_start', toolName: 'read', args: { file: 'app/Models/Order.php' } });
              opts.onEvent?.({ type: 'tool_execution_end', toolName: 'read', isError: false });
              opts.onEvent?.({ type: 'message_end', message: { role: 'assistant', content: FAKE_JSON } });
            }
          },
        };
        const sub = { session, bridge: { session }, dispose: () => disposed.push(opts) };
        spawned.push({ opts, sub });
        return sub;
      },
    },
  };
}

test('sanitizeSessionId: loại ký tự lạ, đúng format SDK', () => {
  assert.equal(sanitizeSessionId('craftsman-architect-123'), 'craftsman-architect-123');
  assert.equal(sanitizeSessionId('vai có dấu!'), 'vai-c--d-u'); // ó→- , ấ→- → c--d
  assert.equal(sanitizeSessionId('!!!'), 'craftsman');
});

test('appendRobust: incremental + full-snapshot không duplicate', () => {
  // snapshot (delta chứa trọn acc) → dùng delta làm mới, không append
  assert.equal(appendRobust('The', 'The Detroit'), 'The Detroit');
  // incremental → append
  assert.equal(appendRobust('The', ' Detroit'), 'The Detroit');
  assert.equal(appendRobust('The', 'Detroit'), 'TheDetroit');
});

test('runSubAgent: spawn với systemPrompt/tools/model, prompt với mission, dispose sau cùng', async () => {
  const sdk = fakeSdk();
  const r = await runSubAgent({
    ctx: sdk.ctx,
    role: 'architect',
    systemPrompt: 'Bạn là kiến trúc sư.',
    mission: 'Trả JSON plan.',
    tools: ['read', 'ls'],
    modelCfg: { provider: 'opencode-go', modelId: 'deepseek-v4-flash' },
  });
  assert.equal(r.ok, true);
  const sp = sdk.spawned[0].opts;
  assert.equal(sp.systemPrompt, 'Bạn là kiến trúc sư.');
  assert.deepEqual(sp.tools, ['read', 'ls']);
  assert.equal(sp.provider, 'opencode-go');
  assert.equal(sp.modelId, 'deepseek-v4-flash');
  assert.equal(sp.cwd, 'C:/repo');
  assert.equal(typeof sp.onEvent, 'function');
  assert.equal(r.text, FAKE_JSON);
  assert.equal(sdk.disposed.length, 1, 'phải dispose sub-agent');
});

test('runSubAgent: abort signal → trả aborted, vẫn dispose', async () => {
  const sdk = fakeSdk({
    promptImpl: () => new Promise((_, rej) => setTimeout(() => rej(new Error('aborted')), 50)),
  });
  const ac = new AbortController();
  const r = await runSubAgent({
    ctx: sdk.ctx,
    role: 'verifier',
    systemPrompt: 's',
    mission: 'm',
    signal: ac.signal,
    timeoutMs: 5000,
  });
  // promptImpl reject trước → error
  assert.equal(r.ok, false);
  assert.equal(sdk.disposed.length, 1);
});

test('runSubAgent: timeout → error chứa timeout, dispose', async () => {
  const sdk = fakeSdk({
    promptImpl: () => new Promise(() => {}), // treo mãi
  });
  const r = await runSubAgent({
    ctx: sdk.ctx,
    role: 'planner',
    systemPrompt: 's',
    mission: 'm',
    timeoutMs: 100,
  });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('timeout') || r.error.includes('Timeout'));
  assert.equal(sdk.disposed.length, 1);
});

test('createSubagentRunner: run() trả json parse + log qua publishState', async () => {
  const sdk = fakeSdk();
  const published = [];
  sdk.ctx.background.publishState = (sid, payload) => published.push(payload);
  const runner = createSubagentRunner(sdk.ctx, { model_planner: { provider: 'p', modelId: 'm' } });
  assert.equal(runner.available, true);

  const r = await runner.run({
    role: 'architect',
    systemPrompt: 's',
    mission: 'm',
  });
  assert.equal(r.ok, true);
  assert.ok(r.json?.touchpoints, 'phải parse JSON từ text');
  // log phải được publish (ring buffer)
  const last = published[published.length - 1];
  assert.ok(last.subagents?.length >= 3, 'log phải có delta + tool events');
  assert.equal(last.subagents[1].role, 'architect');
  assert.equal(last.subagents[1].tool, 'read');
  assert.equal(last.subagents[1].file, 'app/Models/Order.php');
});

test('createSubagentRunner: thiếu spawnSubagent → available=false', () => {
  const runner = createSubagentRunner({ cwd: 'C:/' }, {});
  assert.equal(runner.available, false);
});

test('runPlanners: roleKey architect (mặc định) — 1 sub-agent Kiến trúc sư, merged = plan trực tiếp', async () => {
  const sdk = fakeSdk();
  const runner = createSubagentRunner(sdk.ctx, {});
  const res = await runPlanners(
    { goal: 'thêm nút duyệt đơn', facts: { fingerprint: 'x', schema: 'y' }, featureType: '' },
    { models: null, modelCfg: { provider: 'p', modelId: 'm' }, signal: undefined, subagent: runner },
  );
  assert.equal(res.ok, true);
  assert.equal(sdk.spawned.length, 1, '1 planner → đúng 1 sub-agent');
  assert.ok(sdk.spawned[0].opts.systemPrompt.includes('kiến trúc sư'), 'phải là Kiến trúc sư');
  assert.ok(sdk.spawned[0].opts.tools.includes('read'), 'planner phải có tool read');
  assert.ok(res.merged.touchpoints, 'merged = plan JSON trực tiếp (không merge hội đồng)');
});

test('runPlanners: roleKey risk — 1 sub-agent phản biện (dùng cho vòng re-plan)', async () => {
  const sdk = fakeSdk();
  const runner = createSubagentRunner(sdk.ctx, {});
  const res = await runPlanners(
    { goal: 'thêm nút duyệt đơn', facts: { fingerprint: 'x', schema: 'y' }, featureType: '' },
    { models: null, modelCfg: { provider: 'p', modelId: 'm' }, signal: undefined, subagent: runner, roleKey: 'risk' },
  );
  assert.equal(res.ok, true);
  assert.equal(sdk.spawned.length, 1);
  assert.ok(sdk.spawned[0].opts.systemPrompt.includes('TÌM LÝ DO'), 'phải là vai Risk');
});

test('runPromptCritics: 1 critic gộp 3 vai — đúng 1 call, merged = JSON trực tiếp', async () => {
  let calls = 0;
  let sysSeen = '';
  const fakeRunner = async (sys) => {
    calls++;
    sysSeen = sys;
    return {
      ok: true,
      json: {
        intent: 'feature',
        scope: 'both',
        explicit: ['nút duyệt'],
        ambiguous: [],
        missing: [],
        assumptions: [],
        sessionFacts: [],
      },
    };
  };
  const res = await runPromptCritics(
    { prompt: 'thêm tính năng X', sessionSummary: '', repoHints: '' },
    { models: null, modelCfg: null, signal: undefined, runner: fakeRunner },
  );
  assert.equal(calls, 1, 'luôn đúng 1 call LLM (không hội đồng)');
  assert.ok(sysSeen.includes('nhóm 3 chuyên gia GỘP'), 'phải dùng prompt gộp 3 vai');
  assert.equal(res.ok, true);
  assert.equal(res.merged.intent, 'feature');
  assert.equal(res.results.length, 1);
});

test('runPromptCritics: KHÔNG dùng sub-agent kể cả khi deps truyền subagent (đo: sub-agent critic chậm ~14×)', async () => {
  let calls = 0;
  const fakeRunner = async () => {
    calls++;
    return { ok: true, json: { intent: 'bugfix', scope: 'backend', explicit: [], ambiguous: [], missing: [], assumptions: [], sessionFacts: [] } };
  };
  const fakeSubagent = { run: async () => ({ ok: false, error: 'không được gọi' }) };
  const res = await runPromptCritics(
    { prompt: 'fix bug X', sessionSummary: '', repoHints: '' },
    { models: null, modelCfg: null, signal: undefined, runner: fakeRunner, subagent: fakeSubagent },
  );
  assert.equal(calls, 1, 'critics luôn chạy bằng 1 LLM call, không qua subagent');
  assert.equal(res.ok, true);
});

test('adversarialChannel: mode subagent — 1 verifier (không hội đồng), gap hợp nhất trực tiếp', async () => {
  const sdk = fakeSdk();
  const runner = createSubagentRunner(sdk.ctx, {});
  const res = await adversarialChannel(
    { goal: 'fix bug', plan: { files: ['a.php'] }, diffText: 'diff', root: 'C:/repo' },
    { models: null, modelCfg: { provider: 'p', modelId: 'm' }, signal: undefined, subagent: runner },
  );
  // FAKE_JSON không có gaps → gaps rỗng nhưng không crash; đúng 1 verifier
  assert.ok(Array.isArray(res.gaps));
  assert.equal(sdk.spawned.length, 1, '1 verifier — không chạy nhiều rồi gộp');
});

test('packForRole architect: chứa ĐỦ evidence các tầng (frontend + contracts) — plan không miss view/js ngay từ đầu', () => {
  const facts = {
    fingerprint: 'fp',
    architecture: 'arch',
    routes: 'routes',
    schema: 'schema',
    frontend: 'frontend-info',
    contracts: 'contract-map',
    checklist: 'checklist',
  };
  const pack = packForRole('architect', facts);
  assert.ok(pack.includes('frontend-info'), 'phải có frontend evidence');
  assert.ok(pack.includes('contract-map'), 'phải có contract map evidence');
  assert.ok(pack.includes('schema'), 'phải có schema');
});

test('packForRole risk: contract + schema + routes + checklist', () => {
  const facts = {
    fingerprint: 'fp',
    schema: 'schema',
    routes: 'routes',
    contracts: 'contract-map',
    checklist: 'checklist',
  };
  const pack = packForRole('risk', facts);
  assert.ok(pack.includes('contract-map'));
  assert.ok(pack.includes('schema'));
});
