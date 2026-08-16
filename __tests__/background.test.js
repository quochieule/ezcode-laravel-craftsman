import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundManager } from '../lib/background.js';

/** Stub pi — capture deliver + publish. */
function stubPi() {
  const delivered = [];
  const published = [];
  return {
    pi: {
      sendUserMessage: (text, opts) => delivered.push({ text, opts }),
      publishToSession: (sid, ch, payload) =>
        published.push({ sid, ch, payload }),
    },
    delivered,
    published,
  };
}

test('start: đăng ký task + publish task_start với state công khai', () => {
  const { pi, published } = stubPi();
  const mgr = createBackgroundManager(pi);
  const r = mgr.start('s1', 'C:/repo', { kind: 'plan', stage: 'khởi động' });
  assert.equal(r.ok, true);
  assert.ok(r.taskId.startsWith('bg-'));
  assert.equal(r.task.status, 'running');
  assert.equal(r.task.signal.aborted, false);

  const ev = published.find((p) => p.payload.ev === 'task_start');
  assert.ok(ev, 'phải publish task_start');
  assert.equal(ev.sid, 's1');
  assert.equal(ev.ch, 'laravel-craftsman');
  assert.equal(ev.payload.plan.kind, 'plan');
  // state công khai không lộ signal/abort
  assert.equal(ev.payload.plan.signal, undefined);
  assert.equal(ev.payload.plan.abort, undefined);
});

test('guard: 1 task/session — start lần 2 cùng session bị chặn, session khác OK', () => {
  const { pi } = stubPi();
  const mgr = createBackgroundManager(pi);
  const r1 = mgr.start('s1', 'C:/a');
  assert.equal(r1.ok, true);

  const r2 = mgr.start('s1', 'C:/a');
  assert.equal(r2.ok, false);
  assert.ok(r2.reason.includes('đang chạy nền'));

  const r3 = mgr.start('s2', 'C:/b');
  assert.equal(r3.ok, true, 'session khác phải chạy được');
});

test('update/finish: publish task_update/task_end với stage + progress', () => {
  const { pi, published } = stubPi();
  const mgr = createBackgroundManager(pi);
  const { taskId } = mgr.start('s1', 'C:/a');
  published.length = 0;

  mgr.update(taskId, { stage: 'explorer', progress: 0.25 });
  const up = published.find((p) => p.payload.ev === 'task_update');
  assert.ok(up);
  assert.equal(up.payload.plan.stage, 'explorer');
  assert.equal(up.payload.plan.progress, 0.25);

  mgr.finish(taskId, 'done', { stage: 'xong', progress: 1 });
  const end = published.find((p) => p.payload.ev === 'task_end');
  assert.ok(end);
  assert.equal(end.payload.plan.status, 'done');
  assert.ok(end.payload.plan.doneAt);
});

test('cancelBySession: abort signal + finish canceled + chỉ chạm session đúng', async () => {
  const { pi, published } = stubPi();
  const mgr = createBackgroundManager(pi);
  const a = mgr.start('s1', 'C:/a');
  const b = mgr.start('s2', 'C:/b');
  published.length = 0;

  const n = mgr.cancelBySession('s1');
  assert.equal(n, 1);
  assert.equal(a.task.signal.aborted, true, 'signal phải bị abort');
  assert.equal(b.task.signal.aborted, false, 'session khác không đụng');

  const end = published.find((p) => p.payload.ev === 'task_end');
  assert.ok(end);
  assert.equal(end.payload.plan.status, 'canceled');

  assert.equal(mgr.runningFor('s1'), null);
  assert.ok(mgr.runningFor('s2'), 'task s2 vẫn chạy');
});

test('deliver: gửi followUp khi task running; từ chối khi đã hủy/xong', () => {
  const { pi, delivered } = stubPi();
  const mgr = createBackgroundManager(pi);
  const { taskId } = mgr.start('s1', 'C:/a');

  const ok = mgr.deliver(taskId, '[Craftsman] plan xong');
  assert.equal(ok, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].opts.deliverAs, 'followUp');

  // Sau khi hủy → không deliver
  mgr.cancelBySession('s1');
  const ok2 = mgr.deliver(taskId, '[Craftsman] muộn rồi');
  assert.equal(ok2, false);
  assert.equal(delivered.length, 1, 'không deliver thêm khi task đã hủy');
});

test('pipeline abort: signal báo aborted sau cancel → stage có thể dừng', () => {
  const { pi } = stubPi();
  const mgr = createBackgroundManager(pi);
  const { task } = mgr.start('s1', 'C:/a');
  mgr.cancelBySession('s1');
  assert.equal(task.signal.aborted, true);
});
