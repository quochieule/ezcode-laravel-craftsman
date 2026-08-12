/**
 * understanding-map.js — bản đồ hiểu biết (đặc tả §6.3).
 *
 * Mỗi item: { item, status: verified|inferred|unknown, by: <nguồn>, checkedAt }
 * 3 công dụng: lái vòng explore · runtime guardrail (chặn edit vùng unknown)
 * · minh bạch cho user (panel).
 */
export class UnderstandingMap {
  constructor() {
    this.items = [];
  }

  /** Ghi 1 sự hiểu biết CÓ NGUỒN. */
  add(item, by, status = 'verified') {
    const existing = this.items.find((i) => i.item === item);
    if (existing) {
      existing.by = by;
      existing.status = status;
      existing.checkedAt = Date.now();
      return existing;
    }
    const entry = { item, status, by, checkedAt: Date.now() };
    this.items.push(entry);
    return entry;
  }

  /** Ghi nhận "chưa biết" — kèm lý do. */
  addUnknown(item, why) {
    return this.add(item, `unknown: ${why}`, 'unknown');
  }

  get(item) {
    return this.items.find((i) => i.item === item) || null;
  }

  /** Mọi item unknown — thứ phải resolve trước khi chốt (nếu blocking). */
  unknowns() {
    return this.items.filter((i) => i.status === 'unknown');
  }

  verified() {
    return this.items.filter((i) => i.status === 'verified');
  }

  /**
   * Guardrail: file có nằm trong vùng chưa verified không?
   * Trả list item unknown liên quan file đó (để chặn edit).
   */
  unknownForFile(file) {
    const rel = String(file).replace(/\\/g, '/');
    return this.items.filter(
      (i) => i.status === 'unknown' && String(i.item).includes(rel),
    );
  }

  toJSON() {
    return { items: this.items };
  }
}
