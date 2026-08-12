import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHeuristic, transformForIntent } from '../lib/stages/triage.js';
import { GapRegistry, gapsToQuestions } from '../lib/gap-registry.js';
import { UnderstandingMap } from '../lib/understanding-map.js';

test('triage: nhận diện 8 loại prompt', () => {
  assert.equal(
    classifyHeuristic('kiểm tra lại còn thiếu gì không').intent,
    'reverify',
  );
  assert.equal(
    classifyHeuristic('tại sao form không submit được?').intent,
    'bugfix',
  );
  assert.equal(
    classifyHeuristic('Hệ thống phân quyền thế nào?').intent,
    'question',
  );
  assert.equal(
    classifyHeuristic('thêm nút duyệt đơn cho admin, xong gửi mail cho khách')
      .intent,
    'feature',
  );
  assert.equal(
    classifyHeuristic('dọn dead code trong module order').intent,
    'refactor',
  );
  assert.equal(
    classifyHeuristic('trang orders tải chậm quá, tối ưu giúp').intent,
    'optimize',
  );
  assert.equal(classifyHeuristic('đổi màu nút submit').intent, 'trivial');
});

test('triage: scope backend/frontend/both', () => {
  assert.equal(
    classifyHeuristic('thêm migration cột phone vào bảng users').scope,
    'backend',
  );
  assert.equal(classifyHeuristic('đổi màu nút submit').scope, 'frontend'); // 'nút' = UI
  assert.equal(
    classifyHeuristic('thêm nút duyệt đơn, gửi mail, hiện lên trang detail')
      .scope,
    'both',
  );
});

test('triage: transform đúng theo intent', () => {
  const rv = transformForIntent({ intent: 'reverify', scope: 'both' });
  assert.ok(rv.text.includes('laravel_reverify'));
  assert.ok(!rv.text.includes('laravel_plan'));

  const fe = transformForIntent({ intent: 'feature', scope: 'both' });
  assert.ok(fe.text.includes('laravel_plan'));

  const bf = transformForIntent({ intent: 'bugfix', scope: 'backend' });
  assert.ok(bf.text.includes('laravel_contracts'));

  assert.equal(
    transformForIntent({ intent: 'trivial', scope: 'unclear' }),
    undefined,
  );
  // question → answer-mode transform (trả lời có evidence)
  const q = transformForIntent({ intent: 'question', scope: 'unclear' });
  assert.ok(q.text.includes('laravel_fingerprint'));
});

test('gap-registry: thêm/phân loại/blocking/câu hỏi có vết tìm', () => {
  const r = new GapRegistry();
  r.add({
    type: 'intent',
    what: 'Có cần nhập số tiền thực thu không?',
    evidenceSearched: ['search FormRequest', 'read 3 controllers'],
    priority: 'blocking',
  });
  r.add({
    type: 'evidence',
    what: 'chưa đọc OrderService',
    priority: 'blocking',
  });
  r.add({ type: 'intent', what: 'giả định dùng queue', priority: 'advisory' });

  assert.equal(r.open('intent').length, 2);
  assert.equal(r.blocking().length, 2);

  r.resolve('g-2', 'explored');
  assert.equal(r.open('evidence').length, 0);

  const qs = gapsToQuestions(r.blocking());
  assert.ok(qs[0].includes('đã tìm: search FormRequest'));
  assert.equal(qs.length, 1); // advisory không vào blocking
});

test('understanding-map: verified/unknown + guardrail cho file', () => {
  const m = new UnderstandingMap();
  m.add('OrderService@approve gọi OrderMail', 'code:OrderService.php:42');
  m.addUnknown('resources/views/admin/orders/index.blade.php', 'chưa đọc');
  assert.equal(m.verified().length, 1);
  assert.equal(m.unknowns().length, 1);
  assert.ok(m.unknownForFile('admin/orders/index.blade.php').length >= 1);
  assert.equal(m.unknownForFile('OrderService.php').length, 0);
  assert.equal(m.get('OrderService@approve gọi OrderMail').status, 'verified');
});

test('triage v2: refactor/optimize có transform riêng (đặc tả §4 ma trận)', () => {
  const r1 = transformForIntent({ intent: 'refactor', scope: 'backend' });
  assert.ok(r1.text.includes('laravel_audit'), 'refactor phải ép audit trước');
  assert.ok(
    r1.text.includes('🟡'),
    'phải cảnh báo không xóa possibly-dead vội',
  );
  const r2 = transformForIntent({ intent: 'optimize', scope: 'backend' });
  assert.ok(r2.text.includes('ĐO LƯỜNG'), 'optimize phải ép đo lường trước');
});

test('triage v2: câu hỏi không dấu ? vẫn nhận diện; bugfix giữ ưu tiên', () => {
  assert.equal(
    classifyHeuristic('giải thích cách phân quyền hoạt động').intent,
    'question',
  );
  assert.equal(
    classifyHeuristic('tại sao form không submit được?').intent,
    'bugfix',
  );
  assert.equal(
    classifyHeuristic('Hệ thống phân quyền thế nào?').intent,
    'question',
  );
});

test('audit: 🟢 used được populate từ contract map (không còn rỗng)', async () => {
  const { audit } = await import('../lib/laravel/audit/dead-code.js');
  const result = audit({
    contractMap: {
      urls: [
        {
          url: '/admin/orders/1/approve',
          kind: 'ajax-short',
          dynamic: false,
          match: { route: { uri: 'admin/orders/{order}/approve' } },
        },
      ],
      selectors: [
        { sel: '#approve-order-btn', status: 'found' },
        { sel: '.ghost', status: 'missing' },
      ],
    },
    routes: [],
    controllerFiles: [],
  });
  assert.ok(
    result.used.some((u) => u.type === 'url'),
    'url khớp route phải vào used',
  );
  assert.ok(
    result.used.some(
      (u) => u.type === 'selector' && u.what === '#approve-order-btn',
    ),
  );
  assert.ok(result.broken.some((b) => b.what === '.ghost'));
});
