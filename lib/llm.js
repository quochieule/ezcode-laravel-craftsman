/**
 * llm.js — wrapper gọi model theo vai (pattern get-advice):
 *   ctx.createModelsCollection() → models.getModel(provider, modelId) → completeSimple
 *
 * Mọi stage LLM đều đi qua đây để:
 *   - 1 chỗ xử lý lỗi/abort/JSON parse — không lặp lại ở từng stage
 *   - test được: truyền runner giả vào stages
 */
import { tail } from './exec.js';

/**
 * Gọi 1 model, trả text (hoặc JSON nếu jsonMode).
 * @param {object} models  từ ctx.createModelsCollection()
 * @param {{provider:string, modelId:string}} cfg
 * @param {object} opts { systemPrompt, userPrompt, signal, jsonMode, temperature }
 * @returns {Promise<{ok:true, text:string, json?:object}|{ok:false, error:string}>}
 */
export async function callModel(models, cfg, opts = {}) {
  if (!models || !cfg?.provider || !cfg?.modelId) {
    return {
      ok: false,
      error:
        'Chưa cấu hình model cho vai này (Settings → Extensions → Laravel Craftsman).',
    };
  }
  let model;
  try {
    model = models.getModel(cfg.provider, cfg.modelId);
  } catch (e) {
    return { ok: false, error: `Không resolve được model: ${e.message}` };
  }
  if (!model) {
    return {
      ok: false,
      error: `Model "${cfg.provider}/${cfg.modelId}" không khả dụng. Kiểm tra provider + API key.`,
    };
  }

  const messages = [];
  if (opts.systemPrompt) {
    messages.push({
      role: 'system',
      content: [{ type: 'text', text: opts.systemPrompt }],
    });
  }
  messages.push({
    role: 'user',
    content: [{ type: 'text', text: opts.userPrompt }],
    timestamp: Date.now(),
  });

  try {
    const result = await models.completeSimple(
      model,
      { systemPrompt: opts.systemPrompt, messages },
      { signal: opts.signal },
    );
    if (result?.errorMessage) {
      return { ok: false, error: result.errorMessage };
    }
    const text = Array.isArray(result?.content)
      ? result.content
          .filter((c) => c?.type === 'text')
          .map((c) => c.text)
          .join('\n')
      : String(result?.content ?? '');
    if (!text.trim()) {
      return { ok: false, error: 'Model trả về rỗng.' };
    }
    if (opts.jsonMode) {
      const parsed = extractJson(text);
      if (!parsed)
        return {
          ok: false,
          error: `Model trả về không phải JSON hợp lệ:\n${tail(text, 800)}`,
        };
      return { ok: true, text, json: parsed };
    }
    return { ok: true, text };
  } catch (e) {
    if (opts.signal?.aborted) return { ok: false, error: 'aborted' };
    return { ok: false, error: e.message };
  }
}

/** Trích object JSON đầu tiên từ text (chịu được markdown fence / văn bản thừa). */
export function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  try {
    return JSON.parse(t);
  } catch {
    /* thử lấy khối {...} hoặc [...] đầu tiên */
  }
  const match = t.match(/\{[\s\S]*\}/) || t.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}
