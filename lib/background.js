/**
 * background.js — Background Task Manager (hướng (a)).
 *
 * Tool chạy lâu (laravel_plan) trả về NGAY; pipeline chạy nền trong cùng
 * process sau khi turn đã kết thúc. Tiến trình publish lên panel qua
 * `pi.publishToSession(sessionId, 'laravel-craftsman', ...)`; kết quả đưa lại
 * agent qua `pi.sendUserMessage(text, { deliverAs: 'followUp' })` (turn mới).
 *
 * Quy tắc:
 *   - Mỗi task có AbortController RIÊNG — KHÔNG dùng signal của turn (turn đã
 *     kết thúc; signal cũ có thể bị abort bất cứ lúc nào → giết cả pipeline).
 *   - Guard: tối đa 1 task chạy/session (tránh agent gọi laravel_plan 2-3 lần
 *     liên tiếp → 2-3 pipeline chồng nhau, tốn token vô ích).
 *   - session_shutdown → hủy task của session đó (pi đã chết, deliver vô nghĩa).
 *   - Cancel từ panel → abort signal → các stage nhận `signal.aborted` và dừng.
 *
 * LƯU Ý payload: mọi event publish có key TOP-LEVEL `plan` (state công khai của
 * task) — panel schema (index.js) tham chiếu qua field path `plan.*`; state của
 * panel = payload cuối cùng nhận được (ExtensionPanelHost), nên key phải khớp
 * đúng tên field trong schema, KHÔNG được đặt tên khác (VD `task`).
 *
 * Pattern tham chiếu: extensions/workflows (runControllers + runStore) — nhưng
 * bản này nhẹ hơn, chỉ phục vụ pipeline của craftsman.
 */
import { randomBytes } from 'node:crypto';

/**
 * Tạo manager gắn với 1 instance pi (mỗi extension instance 1 registry riêng).
 * @param {object} pi — ExtensionAPI ezcode (publishToSession, sendUserMessage)
 */
export function createBackgroundManager(pi) {
  /** @type {Map<string, object>} taskId → task */
  const tasks = new Map();

  const publish = (sessionId, payload) => {
    try {
      pi.publishToSession?.(sessionId, 'laravel-craftsman', payload);
    } catch {
      /* panel runtime không có — bỏ qua */
    }
  };

  const finish = (taskId, status, patch = {}) => {
    const t = tasks.get(taskId);
    if (!t) return null;
    t.status = status;
    t.doneAt = Date.now();
    Object.assign(t, patch);
    publish(t.sessionId, { ev: 'task_end', plan: publicTask(t) });
    return t;
  };

  return {
    /** Publish event tới panel của session (dùng chung cho mọi stage). */
    publish,

    /**
     * Publish payload KÈM state task hiện tại của session.
     * Panel state = payload cuối cùng (ExtensionPanelHost) — nếu publish payload
     * không có key `plan`, field plan.* trên panel biến mất. Dùng cho các sự
     * kiện phụ (VD log sub-agent) cần giữ card plan hiển thị.
     * @param {string|null} sessionId
     * @param {object} extra — payload phụ (VD { subagents: [...] })
     */
    publishState(sessionId, extra = {}) {
      const t = [...tasks.values()]
        .filter((x) => x.sessionId === sessionId)
        .pop();
      publish(sessionId, { ...(t ? { plan: publicTask(t) } : {}), ...extra });
    },

    /**
     * Đăng ký 1 background task. Guard: 1 task chạy/session.
     * @param {string|null} sessionId
     * @param {string} cwd
     * @param {{kind?: string, stage?: string}} meta
     * @returns {{ok:true, taskId:string, task:object, signal:AbortSignal}
     *          |{ok:false, reason:string}}
     */
    start(sessionId, cwd, meta = {}) {
      const running = [...tasks.values()].find(
        (t) => t.sessionId === sessionId && t.status === 'running',
      );
      if (running) {
        return {
          ok: false,
          reason:
            `Đã có 1 task ${running.kind || 'pipeline'} đang chạy nền ` +
            `(task ${running.id.slice(0, 8)} — ${running.stage || 'khởi động'}). ` +
            `Chờ nó xong — kết quả sẽ được gửi vào hội thoại. ` +
            `Đừng gọi laravel_plan lần nữa cho tới khi nhận được kết quả ` +
            `(hoặc hủy qua panel Craftsman nếu cần chạy lại).`,
        };
      }
      const id = `bg-${Date.now()}-${randomBytes(3).toString('hex')}`;
      const controller = new AbortController();
      const task = {
        id,
        sessionId,
        cwd,
        kind: meta.kind || 'pipeline',
        status: 'running', // running | done | error | canceled | awaiting
        stage: meta.stage || 'queued',
        progress: 0,
        startedAt: Date.now(),
        doneAt: null,
        signal: controller.signal,
        abort: () => controller.abort(),
      };
      tasks.set(id, task);
      publish(sessionId, { ev: 'task_start', plan: publicTask(task) });
      return { ok: true, taskId: id, task };
    },

    /** Cập nhật stage/progress → publish lên panel. */
    update(taskId, patch) {
      const t = tasks.get(taskId);
      if (!t) return null;
      Object.assign(t, patch);
      publish(t.sessionId, { ev: 'task_update', plan: publicTask(t) });
      return t;
    },

    /** Kết thúc task (done/error/canceled/awaiting) → publish. */
    finish,

    /** Task đang chạy của 1 session (nếu có). */
    runningFor(sessionId) {
      return (
        [...tasks.values()].find(
          (t) => t.sessionId === sessionId && t.status === 'running',
        ) || null
      );
    },

    /** Hủy mọi task đang chạy của 1 session (session_shutdown / panel cancel). */
    cancelBySession(sessionId) {
      let n = 0;
      for (const t of [...tasks.values()]) {
        if (t.sessionId === sessionId && t.status === 'running') {
          t.abort();
          finish(t.id, 'canceled', { stage: 'canceled' });
          n++;
        }
      }
      return n;
    },

    /**
     * Gửi kết quả về agent (followUp — agent xử lý ở turn mới).
     * Chỉ deliver khi task còn chạy (không deliver task đã hủy/lỗi).
     * @param {string} taskId
     * @param {string} text
     */
    deliver(taskId, text) {
      const t = tasks.get(taskId);
      if (!t || t.status !== 'running' || !text) return false;
      try {
        pi.sendUserMessage?.(text, { deliverAs: 'followUp' });
        return true;
      } catch {
        /* session có thể đã chết — panel vẫn còn thông tin cuối */
        return false;
      }
    },
  };
}

/** Task state công khai (không lộ signal/abort). */
function publicTask(t) {
  return {
    id: t.id,
    kind: t.kind,
    status: t.status,
    stage: t.stage,
    progress: t.progress,
    startedAt: t.startedAt,
    doneAt: t.doneAt,
  };
}
