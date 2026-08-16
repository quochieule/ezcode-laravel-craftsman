/**
 * subagent.js — chạy sub-agent THẬT (hướng (b)) qua `pi.spawnSubagent`.
 *
 * Mỗi "subagent" = 1 AgentSession in-process (SubAgentFactory — backend/src/agent/
 * sub-agent.js): có TOOL THẬT (read/ls/find/grep — read-only), context BLANK
 * (fresh eyes — evidence đưa qua system prompt, verifier KHÔNG thấy hội thoại
 * gốc đúng đặc tả RVP), model override, event sink forward lên panel.
 *
 * Reference: extensions/workflows/src/runner.js (runFlowSubAgent) — cùng pattern:
 * spawnSubagent → session.prompt(mission) 1 lượt → gom output → dispose.
 *
 * Khác callModel thường: mỗi sub-agent chạy 1 AGENT LOOP (nhiều LLM call +
 * tool call, tuần tự nội bộ) — chậm hơn và tốn token hơn, đổi lại:
 *   - planner tự ĐỌC FILE THẬT để kiểm chứng touchpoint (hết hallucination file)
 *   - verifier tự kiểm chứng evidence file:line → giảm false-missing → giảm
 *     vòng lặp reverify (bằng chứng thực tế: 71–73 vòng trên BizHub)
 *
 * Opt-in qua settings `use_subagents` (mặc định OFF — giữ hành vi cũ).
 */
import { extractJson } from './llm.js';

/** Session id hợp lệ cho SDK pi-coding-agent (copy từ workflows/src/snapshot.js). */
export function sanitizeSessionId(raw, fallback = 'craftsman') {
  const s = String(raw ?? '')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  return (s || fallback).slice(0, 100);
}

/** Cộng dồn delta text — chịu cả incremental lẫn full-snapshot (copy workflows). */
export function appendRobust(acc, delta) {
  if (!acc) return delta;
  if (typeof delta !== 'string' || !delta) return acc;
  if (delta.length > acc.length && delta.startsWith(acc)) return delta;
  return acc + delta;
}

/** Wrap promise với timeout + abort signal (copy workflows runner). */
export function withTimeout(promise, signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Sub-agent timeout sau ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Event của sub-agent session → payload gọn cho panel. */
function mapEvent(role, event) {
  switch (event.type) {
    case 'message_update': {
      // delta thật nằm trong assistantMessageEvent (text_delta) — full content
      // là snapshot, dùng sẽ duplicate (xem workflows runner.js)
      const asst = event.assistantMessageEvent;
      if (asst?.type === 'text_delta' && typeof asst.delta === 'string' && asst.delta) {
        return { ev: 'delta', delta: asst.delta };
      }
      return null;
    }
    case 'tool_execution_start': {
      const args = event.args || {};
      return {
        ev: 'tool',
        tool: event.toolName,
        file: args?.file || args?.path || null,
      };
    }
    case 'tool_execution_end':
      return { ev: 'tool_end', tool: event.toolName, isError: event.isError };
    case 'message_end':
      return { ev: 'done' };
    default:
      return null;
  }
}

/**
 * Chạy 1 sub-agent 1 lượt.
 * @param {object} opts
 * @param {object} opts.ctx — { cwd, spawnSubagent, forkContext, sessionManager, background }
 * @param {string} opts.role — nhãn cho panel (VD 'architect', 'verifier')
 * @param {string} opts.systemPrompt — system prompt của vai (gồm evidence pack)
 * @param {string} opts.mission — user prompt (goal + schema hint + chỉ thị kiểm chứng)
 * @param {string[]} [opts.tools] — allow-list tool (mặc định read-only)
 * @param {{provider?:string, modelId?:string}} [opts.modelCfg] — override model
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onLog] — (item) → đẩy log lên panel
 * @returns {Promise<{ok:true, text:string}|{ok:false, error:string}>}
 */
export async function runSubAgent({
  ctx,
  role,
  systemPrompt,
  mission,
  tools = ['read', 'ls', 'find', 'grep'],
  modelCfg,
  timeoutMs = 180000,
  signal,
  onLog,
}) {
  if (typeof ctx?.spawnSubagent !== 'function') {
    return { ok: false, error: 'thiếu pi.spawnSubagent' };
  }

  // SessionManager in-memory BLANK (fresh eyes) — evidence chỉ qua system prompt.
  let sm = null;
  try {
    const sdks = await ctx.forkContext?.();
    sm = sdks?.SessionManager?.inMemory?.();
    sm?.newSession?.({ id: sanitizeSessionId(`craftsman-${role}-${Date.now()}`) });
  } catch {
    sm = null;
  }
  if (!sm) {
    return { ok: false, error: 'thiếu pi.forkContext() (SessionManager)' };
  }

  let outputText = '';
  let sub = null;
  try {
    sub = await ctx.spawnSubagent({
      cwd: ctx.cwd,
      sessionManager: sm,
      tools,
      systemPrompt,
      ...(modelCfg?.provider && modelCfg?.modelId ? modelCfg : {}),
      onEvent: (event) => {
        const p = mapEvent(role, event);
        if (!p) return;
        if (p.ev === 'delta') outputText = appendRobust(outputText, p.delta);
        onLog?.({ role, ...p });
      },
    });

    await withTimeout(
      sub.session.prompt(mission, { expandPromptTemplates: false }),
      signal,
      timeoutMs,
    );

    let text = outputText.trim();
    if (!text) {
      // Fallback: đọc message cuối từ session (nếu provider không gửi delta)
      try {
        const msgs = sub.bridge?.session?.messages ?? sub.session?.messages ?? [];
        const last = msgs[msgs.length - 1];
        text = (
          typeof last?.content === 'string'
            ? last.content
            : JSON.stringify(last?.content ?? '')
        ).trim();
      } catch {
        /* */
      }
    }
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    if (!text) return { ok: false, error: 'sub-agent trả về rỗng.' };
    return { ok: true, text };
  } catch (e) {
    if (signal?.aborted) return { ok: false, error: 'aborted' };
    return { ok: false, error: e?.message || String(e) };
  } finally {
    try {
      sub?.dispose();
    } catch {
      /* */
    }
  }
}

/**
 * Tạo runner dùng chung cho các stage (critics/planners/verifiers).
 * @param {object} cfg — extension settings
 */
export function createSubagentRunner(ctx, cfg = {}) {
  const available =
    typeof ctx?.spawnSubagent === 'function' &&
    typeof ctx?.forkContext === 'function';
  const defaultModel = cfg.model_planner || null;
  const sessionId = ctx?.sessionManager?.getSessionId?.() || null;
  const logs = new Map(); // sessionId → array (cap 15)

  const pushLog = (item) => {
    if (!sessionId) return;
    const arr = logs.get(sessionId) || [];
    arr.push({ ...item, t: Date.now() });
    if (arr.length > 15) arr.shift();
    logs.set(sessionId, arr);
    try {
      ctx.background?.publishState?.(sessionId, { subagents: arr });
    } catch {
      /* panel không có */
    }
  };

  return {
    available,
    /**
     * Chạy 1 vai như sub-agent thật.
     * @returns {Promise<{ok:true, text:string, json?:object}|{ok:false, error:string}>}
     */
    async run({ role, systemPrompt, mission, tools, modelCfg, timeoutMs, signal }) {
      if (!available) return { ok: false, error: 'subagent runner unavailable' };
      const r = await runSubAgent({
        ctx,
        role,
        systemPrompt,
        mission,
        tools,
        modelCfg: modelCfg || defaultModel,
        timeoutMs,
        signal,
        onLog: pushLog,
      });
      if (!r.ok) return r;
      const json = extractJson(r.text);
      if (!json) return { ok: false, error: 'sub-agent không trả JSON hợp lệ.' };
      return { ok: true, text: r.text, json };
    },
  };
}
