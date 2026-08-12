/**
 * triage.js — phân loại mọi prompt: intent × scope × mức độ (đặc tả §5).
 *
 * 2 lớp:
 *   1. Heuristic deterministic (miễn phí, không cần model) — chạy trước
 *   2. LLM refine (nếu có model) — xác nhận lại phân loại, đánh dấu bất đồng
 *
 * Intent: feature | bugfix | question | reverify | refactor | optimize | trivial
 * Scope:  backend | frontend | both | unclear
 */

const REVERIFY_RE =
  /kiểm tra lại|còn thiếu gì|chắc chưa|soát lại|verify lại|review lại|check lại|re-check|còn sót|thiếu sót gì|chạy lại test/i;
const QUESTION_RE =
  /^(tại sao|vì sao|như thế nào|là gì|thế nào|giải thích|giúp tôi hiểu|cho tôi biết|ai|làm sao)\b/i;
const BUGFIX_RE =
  /lỗi|bug|fail|không (chạy|hoạt động|submit|vào được|đăng nhập|hiển thị)|báo (lỗi|sai)|exception|500|404|hỏng|sai kết quả|tại sao/i;
const REFACTOR_RE =
  /refactor|tái cấu trúc|dọn|cleanup|tối ưu hóa cấu trúc|chia tách|gom/i;
const OPTIMIZE_RE = /tối ưu|chậm|nhanh hơn|performance|query nặng|n\+1|index/i;
const TRIVIAL_RE =
  /^(đổi|thêm|sửa|xoá|xóa) (màu|chữ|text|label|tên nút|placeholder)/i;

const FEATURE_RE =
  /thêm|tạo|viết|xây dựng|implement|feature|chức năng|tính năng|màn hình|trang|form|api mới|endpoint/i;

const BACKEND_RE =
  /api|route|controller|model|migration|eloquent|query|db|database|schema|service|repository|validation|formrequest|policy|middleware|seeder|factory|command|job|queue|mail|event|listener|observer/i;
const FRONTEND_RE =
  /blade|view|js|jquery|ajax|css|giao diện|ui|màn hình|trang|form|nút|button|modal|toast|hiển thị|render|selector|dom/i;

const LARAVEL_RE = /laravel|blade|eloquent|artisan|route|migration|middleware/i;

/** Heuristic classify — deterministic, không cần model. */
export function classifyHeuristic(text) {
  const t = String(text || '').trim();
  let intent = 'feature';
  let scope;
  let level = 'moderate';

  if (!t)
    return {
      intent: 'trivial',
      scope: 'unclear',
      level: 'trivial',
      heuristic: true,
    };

  if (REVERIFY_RE.test(t)) intent = 'reverify';
  else if (BUGFIX_RE.test(t)) intent = 'bugfix';
  else if (
    QUESTION_RE.test(t) ||
    (t.trim().endsWith('?') && !FEATURE_RE.test(t))
  )
    intent = 'question';
  else if (REFACTOR_RE.test(t)) intent = 'refactor';
  else if (OPTIMIZE_RE.test(t)) intent = 'optimize';
  else if (TRIVIAL_RE.test(t)) intent = 'trivial';
  else if (
    !FEATURE_RE.test(t) &&
    !LARAVEL_RE.test(t) &&
    t.split(/\s+/).length <= 6
  )
    intent = 'trivial';

  const backend = BACKEND_RE.test(t);
  const frontend = FRONTEND_RE.test(t);
  if (backend && frontend) scope = 'both';
  else if (backend) scope = 'backend';
  else if (frontend) scope = 'frontend';
  else scope = 'unclear';

  // mức độ: thô — dựa độ dài + độ phức tạp từ khóa
  if (intent === 'trivial' || intent === 'question') level = 'trivial';
  else if (t.split(/\s+/).length < 8) level = 'simple';
  else if (t.split(/\s+/).length > 30) level = 'complex';

  return { intent, scope, level, heuristic: true };
}

const INTENT_LABEL = {
  feature: 'feature',
  bugfix: 'bugfix',
  question: 'question',
  reverify: 'reverify',
  refactor: 'refactor',
  optimize: 'optimize',
  trivial: 'trivial',
};

/**
 * Triage đầy đủ: heuristic + (optional) LLM refine.
 * @returns {Promise<{intent:string, scope:string, level:string, heuristic:boolean, llm?:object, disagreement:boolean}>}
 */
export async function triage(text, { models, modelCfg, signal } = {}) {
  const h = classifyHeuristic(text);
  if (!models || !modelCfg?.provider || !modelCfg?.modelId) return h;

  const { callModel } = await import('../llm.js');
  const res = await callModel(models, modelCfg, {
    systemPrompt:
      'Bạn phân loại yêu cầu của user trong coding agent Laravel. Trả JSON thuần: ' +
      '{"intent":"feature|bugfix|question|reverify|refactor|optimize|trivial",' +
      '"scope":"backend|frontend|both|unclear","level":"trivial|simple|moderate|complex",' +
      '"reason":"1 câu ngắn"}. Nếu prompt là câu hỏi kiến thức (không yêu cầu sửa code) → question. ' +
      '"kiểm tra lại/còn thiếu gì" → reverify.',
    userPrompt: `Prompt: ${String(text).slice(0, 2000)}`,
    jsonMode: true,
    signal,
  });

  if (!res.ok) return h;
  const j = res.json || {};
  const intent = INTENT_LABEL[j.intent] || h.intent;
  const disagreement = intent !== h.intent;
  return {
    intent,
    scope: ['backend', 'frontend', 'both', 'unclear'].includes(j.scope)
      ? j.scope
      : h.scope,
    level: ['trivial', 'simple', 'moderate', 'complex'].includes(j.level)
      ? j.level
      : h.level,
    heuristic: false,
    llm: { reason: j.reason },
    disagreement,
  };
}

/** Biến đổi prompt để ép agent dùng pipeline đúng (đặc tả §4-①). */
export function transformForIntent(triage) {
  const { intent, scope } = triage;
  if (intent === 'reverify') {
    return {
      action: 'transform',
      text:
        '[Craftsman] User yêu cầu KIỂM TRA LẠI. KHÔNG giải thích lại, KHÔNG làm lại từ đầu. ' +
        'Gọi laravel_reverify để chạy Re-Verification Protocol (kiểm tra toàn bộ theo per-item) ' +
        'trước khi trả lời. Sau đó sửa mọi thứ báo cáo đánh dấu thiếu.',
    };
  }
  if (intent === 'question') {
    return {
      action: 'transform',
      text:
        '[Craftsman] Đây là câu hỏi về codebase — trả lời CÓ EVIDENCE: dùng laravel_fingerprint, ' +
        'laravel_schema, laravel_contracts, đọc file cụ thể, trích file:dòng. Không trả lời chung chung.',
    };
  }
  if (intent === 'feature' && scope !== 'trivial') {
    return {
      action: 'transform',
      text:
        '[Craftsman] Yêu cầu thay đổi code nhiều tầng. BẮT BUỘC gọi laravel_plan(goal=...) TRƯỚC ' +
        'khi sửa bất kỳ file nào, rồi làm theo plan. Nếu laravel_plan trả câu hỏi cần user trả lời — hãy hỏi user trước khi tiếp tục.',
    };
  }
  if (intent === 'bugfix') {
    return {
      action: 'transform',
      text:
        '[Craftsman] Đây là bugfix: TRUY NGƯỢC nguyên nhân trước khi sửa — dùng laravel_contracts ' +
        '(broken links), laravel_schema (schema thật), đọc code liên quan, xác định root cause, ' +
        'rồi mới sửa. Không đoán, không sửa bừa.',
    };
  }
  if (intent === 'refactor') {
    return {
      action: 'transform',
      text:
        '[Craftsman] Yêu cầu refactor/dọn code: gọi laravel_audit TRƯỚC (dead code 3 mức + broken ' +
        'links). 🟡 possibly-dead KHÔNG được xóa ngay — xác minh thêm rồi hỏi user. 🔴 broken thì ' +
        'sửa/xóa. Sau đó mới lập kế hoạch dọn.',
    };
  }
  if (intent === 'optimize') {
    return {
      action: 'transform',
      text:
        '[Craftsman] Yêu cầu tối ưu: ĐO LƯỜNG trước khi sửa — laravel_schema (query/column thật), ' +
        'đọc code path bị chậm, xác định bottleneck CÓ BẰNG CHỨNG rồi mới tối ưu. Không tối ưu theo cảm giác.',
    };
  }
  return undefined; // trivial → không can thiệp
}
