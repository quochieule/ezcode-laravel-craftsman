/**
 * Blueprint — kiến thức tĩnh về Laravel: vertical chain checklist theo loại
 * feature. Đây là "xương sống" chống bỏ sót: mỗi loại việc có danh sách
 * touchpoint bắt buộc — deterministic, không phụ thuộc model có nhớ hay không.
 */

/** Vertical chain chung — mọi feature Laravel đi qua các mắt xích này. */
export const VERTICAL_CHAIN = [
  {
    id: 'route',
    label: 'Route (web/api) + middleware',
    ask: 'Route đã tồn tại? Middleware auth/role đúng?',
  },
  {
    id: 'controller',
    label: 'Controller@method',
    ask: 'Method tồn tại? Theo naming convention repo?',
  },
  {
    id: 'validation',
    label: 'Validation (FormRequest/inline)',
    ask: 'Dự án dùng FormRequest hay validate inline? Rule đủ cho field mới?',
  },
  {
    id: 'service',
    label: 'Service/Repository (nếu có convention)',
    ask: 'Logic nặng đặt service hay controller dày?',
  },
  {
    id: 'model',
    label: 'Model + relationships',
    ask: 'Fillable/casts/relations đúng? Quan hệ với bảng nào?',
  },
  {
    id: 'migration',
    label: 'Migration/schema',
    ask: 'Cần cột/bảng mới? Khớp schema hiện tại?',
  },
  {
    id: 'policy',
    label: 'Policy/Gate (nếu có auth)',
    ask: 'Quyền đã được check ở đúng tầng?',
  },
  {
    id: 'view',
    label: 'Blade view (extends/section/partial)',
    ask: 'View nằm đúng layout? Có partial tái dùng?',
  },
  {
    id: 'js',
    label: 'JS handler (selector + event)',
    ask: 'Selector khớp DOM? Dùng confirm modal convention?',
  },
  {
    id: 'ajax',
    label: 'AJAX url + CSRF',
    ask: 'URL khớp route thật? CSRF setup đúng convention repo?',
  },
  {
    id: 'callback',
    label: 'JS success/error callback → DOM',
    ask: 'DOM target tồn tại? Error pattern (toast/alert) đúng convention?',
  },
  {
    id: 'side-effect',
    label: 'Event/Job/Notification (nếu cần)',
    ask: 'Side-effect có cần không? Theo convention repo (đừng tự sáng tạo event mới)?',
  },
  {
    id: 'test',
    label: 'Test (Feature + guard case)',
    ask: 'Test nào tồn tại/sẽ thêm? Case biên (guard) có test không?',
  },
  {
    id: 'log',
    label: 'Log theo convention',
    ask: 'Dự án log kiểu gì (Log::/logger()/activity())? Thao tác này có cần log?',
  },
];

/** Checklist chi tiết theo loại feature (8 loại v1). */
export const FEATURE_BLUEPRINTS = {
  'api-endpoint': {
    label: 'API endpoint mới',
    touchpoints: [
      'route',
      'controller',
      'validation',
      'service',
      'model',
      'policy',
      'ajax',
      'callback',
      'test',
      'log',
    ],
    notes:
      'Response format phải khớp convention (API Resource? json() thường?).',
  },
  'model-relationship': {
    label: 'Model + relationship mới',
    touchpoints: [
      'migration',
      'model',
      'service',
      'controller',
      'view',
      'js',
      'ajax',
      'test',
    ],
    notes: 'Relationship phải đối chiếu khóa ngoại thật trong migrations.',
  },
  'auth-route': {
    label: 'Route có auth/phân quyền',
    touchpoints: ['route', 'policy', 'controller', 'validation', 'test', 'log'],
    notes: 'Middleware vs Policy — check convention repo (đừng tự chọn).',
  },
  'job-queue': {
    label: 'Job/Queue',
    touchpoints: ['side-effect', 'controller', 'service', 'test', 'log'],
    notes:
      'Repo có dùng queue thật không (about → queue driver)? Đừng tự giới thiệu queue nếu repo đang sync.',
  },
  'notification-mail': {
    label: 'Notification/Mail',
    touchpoints: ['side-effect', 'view', 'controller', 'test', 'log'],
    notes:
      'Template có sẵn? Đừng tạo template mới khi có template cũ dùng được.',
  },
  command: {
    label: 'Artisan command',
    touchpoints: [
      'route',
      'controller',
      'service',
      'side-effect',
      'test',
      'log',
    ],
    notes: 'Command đăng ký ở đâu? schedule có cần không?',
  },
  'form-validation': {
    label: 'Form/Validation',
    touchpoints: [
      'view',
      'js',
      'ajax',
      'validation',
      'controller',
      'callback',
      'test',
    ],
    notes:
      'Field names phải khớp GIỮA blade ↔ JS ↔ FormRequest (contract diff).',
  },
  'report-query': {
    label: 'Báo cáo/Query nặng',
    touchpoints: ['controller', 'service', 'model', 'view', 'test'],
    notes: 'N+1? Chunk? Index? Query đối chiếu schema thật.',
  },
};

/** Tra checklist theo loại — fallback vertical chain đầy đủ. */
export function checklistFor(type) {
  const bp = FEATURE_BLUEPRINTS[type];
  if (!bp)
    return {
      label: type || 'general',
      touchpoints: VERTICAL_CHAIN.map((t) => t.id),
      notes: '',
    };
  return bp;
}

/** Render checklist gọn cho agent. */
export function renderChecklist(type) {
  const bp = checklistFor(type);
  const items = bp.touchpoints
    .map((id) => {
      const t = VERTICAL_CHAIN.find((x) => x.id === id);
      return t ? `  - [ ] ${t.label} — ${t.ask}` : `  - [ ] ${id}`;
    })
    .join('\n');
  return `Checklist "${bp.label}":\n${items}${bp.notes ? `\nLưu ý: ${bp.notes}` : ''}`;
}
