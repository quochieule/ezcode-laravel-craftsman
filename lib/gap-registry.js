/**
 * gap-registry.js — "sổ nợ hiểu biết" duy nhất (đặc tả §6.2).
 *
 * Luật bất biến: CHỈ deterministic tạo gap; LLM chỉ chuyển gap thành câu hỏi
 * (hoặc đề xuất explore). Gap phải có bằng chứng đã tìm — không bao giờ hỏi
 * điều tự đọc được.
 *
 * 3 đường xử lý theo thứ tự bắt buộc:
 *   ① EXPLORE — trả lời được bằng code?
 *   ② ASK     — không có trong code + blocking → hỏi user (kèm vết tìm)
 *   ③ UNKNOWN — không chặn → dán nhãn, đi tiếp, khai báo trong plan
 */

export const GAP_TYPES = ['intent', 'evidence', 'contract', 'conflict'];

export class GapRegistry {
  constructor() {
    this.gaps = []; // { id, type, what, evidenceSearched[], priority, status, resolvedBy }
  }

  add({
    type,
    what,
    evidenceSearched = [],
    priority = 'blocking',
    status = 'open',
  }) {
    if (!GAP_TYPES.includes(type)) type = 'evidence';
    const gap = {
      id: `g-${this.gaps.length + 1}`,
      type,
      what: String(what),
      evidenceSearched: evidenceSearched.map(String),
      priority,
      status,
      resolvedBy: null,
    };
    this.gaps.push(gap);
    return gap;
  }

  /** Gap mở theo loại. */
  open(type) {
    return this.gaps.filter(
      (g) => g.status === 'open' && (!type || g.type === type),
    );
  }

  /** Gap mở + blocking — thứ phải giải quyết trước khi chốt. */
  blocking() {
    return this.open().filter((g) => g.priority === 'blocking');
  }

  resolve(id, by) {
    const g = this.gaps.find((x) => x.id === id);
    if (g) {
      g.status = 'resolved';
      g.resolvedBy = by;
    }
    return g;
  }

  markUnknown(id, reason) {
    const g = this.gaps.find((x) => x.id === id);
    if (g) {
      g.status = 'unknown';
      g.resolvedBy = reason;
    }
    return g;
  }

  /**
   * Phân loại gap: intent (không có trong code → hỏi) hay evidence (đọc được → explore).
   * Đây là quyết định DUY NHẤT model được phép đưa ra trên gap — vì nó cần phán đoán
   * "thông tin này có nằm trong codebase không".
   */
  classify(id, type) {
    const g = this.gaps.find((x) => x.id === id);
    if (g && GAP_TYPES.includes(type)) g.type = type;
    return g;
  }

  toJSON() {
    return { gaps: this.gaps };
  }
}

/**
 * Chuyển gap intent/blocking thành câu hỏi cho user — theo chuẩn đặc tả §6.2:
 * kèm vết tìm, có option khi có thể, giới hạn số câu.
 */
export function gapsToQuestions(gaps, { max = 5 } = {}) {
  return gaps.slice(0, max).map((g, i) => {
    const searched = g.evidenceSearched.length
      ? ` (đã tìm: ${g.evidenceSearched.join('; ')})`
      : '';
    return `${i + 1}. ${g.what}${searched}`;
  });
}
