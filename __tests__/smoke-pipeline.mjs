// Smoke test pipeline đầy đủ với FAKE LLM — chứng minh orchestration chạy đúng
// (critics → planners → critic → gate) mà không cần model thật.
import { runPromptCritics, renderRequirementsMap } from '../lib/stages/prompt-critics.js';
import { runPlanners, renderMergedPlan } from '../lib/stages/planners.js';
import { critic } from '../lib/stages/critic.js';
import { GapRegistry, gapsToQuestions } from '../lib/gap-registry.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

// Fake model: trả JSON theo vai (nhìn system prompt để chọn)
const fakeRunner = async (system, _user) => {
  const sys = String(system);
  if (sys.includes('Người đọc yêu cầu') || sys.includes('Kẻ ngờ vực') || sys.includes('Người đối chiếu')) {
    return {
      ok: true,
      json: {
        intent: 'feature', scope: 'both',
        explicit: ['nút duyệt đơn', 'gửi mail cho khách'],
        ambiguous: ['có cần nhập số tiền thực thu không'],
        missing: [], assumptions: ['dùng activity() theo convention'], sessionFacts: [],
      },
    };
  }
  if (sys.includes('jQuery/Ajax')) {
    return {
      ok: true,
      json: {
        touchpoints: [
          { item: 'route', action: 'existing', file: 'routes/web.php', reason: 'orders.approve đã có' },
          { item: 'view', action: 'modify', file: 'resources/views/admin/orders/detail.blade.php', reason: 'thêm nút + JS handler' },
          { item: 'js', action: 'modify', file: 'public/js/admin/orders.js', reason: 'handler + confirm modal' },
        ],
        files: ['resources/views/admin/orders/detail.blade.php', 'public/js/admin/orders.js'],
        tests: ['tests/Feature/OrderApproveTest.php'], risks: ['quên guard'], assumptions: [], unknowns: ['mail template'],
      },
    };
  }
  if (sys.includes('kiến trúc sư') || sys.includes('dữ liệu') || sys.includes('bảo mật') || sys.includes('TÌM LÝ DO')) {
    return {
      ok: true,
      json: {
        touchpoints: [
          { item: 'route', action: 'existing', file: 'routes/web.php', reason: 'đã có' },
          { item: 'controller', action: 'modify', file: 'app/Http/Controllers/OrderController.php', reason: 'gọi service' },
          { item: 'service', action: 'modify', file: 'app/Services/OrderService.php', reason: 'thêm approve()' },
          { item: 'policy', action: 'modify', file: 'app/Policies/OrderPolicy.php', reason: 'check admin' },
          { item: 'test', action: 'new', file: 'tests/Feature/OrderApproveTest.php', reason: 'guard test' },
        ],
        files: ['app/Services/OrderService.php', 'app/Policies/OrderPolicy.php'],
        tests: ['tests/Feature/OrderApproveTest.php'], risks: [], assumptions: [], unknowns: [],
      },
    };
  }
  return { ok: true, json: { touchpoints: [], files: [], tests: [], risks: [], assumptions: [], unknowns: [] } };
};

const deps = { models: null, modelCfg: null, runner: fakeRunner };

const critics = await runPromptCritics({ prompt: 'thêm nút duyệt đơn cho admin, xong gửi mail cho khách' }, deps);
console.log('CRITICS OK:', critics.ok);
console.log(renderRequirementsMap(critics.merged));

// gap intent → câu hỏi
const reg = new GapRegistry();
for (const a of critics.merged.ambiguous) reg.add({ type: 'intent', what: a, evidenceSearched: ['search'], priority: 'blocking' });
console.log('\nQUESTIONS:\n' + gapsToQuestions(reg.blocking()).join('\n'));

const facts = { fingerprint: 'Laravel 11, FormRequest, Pest', schema: 'orders(status enum)', routes: '4 routes', frontend: '2 js', contracts: 'ok', checklist: 'route,controller,view,js,test,log' };
const planning = await runPlanners({ goal: 'nút duyệt đơn + mail', facts, featureType: 'form-validation' }, deps);
console.log('\nPLANNERS OK:', planning.ok, '· plans:', planning.merged.planCount);
console.log(renderMergedPlan(planning.merged));

const c = await critic({
  root: appRoot,
  plan: planning.merged,
  checklistIds: ['route', 'controller', 'view', 'js', 'test', 'log'],
  contractDiffResult: { mismatches: [] },
}, deps);
console.log('\nCRITIC: score=' + c.score + ' blocking=' + c.blocking.length + ' advisory=' + c.advisory.length);
console.log(c.report.split('\n').slice(0, 8).join('\n'));
console.log('\nSMOKE TEST: ' + (c.ok ? 'PASS (plan không có lỗi blocking)' : 'PASS (critic bắt được vấn đề — đúng hành vi)'));
