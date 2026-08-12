# Laravel Craftsman — Senior Code Intelligence cho Laravel

Extension riêng cho **ezcode**, chỉ dùng cho source **Laravel + Blade + jQuery/Ajax**.

Mục tiêu: làm cho ezcode hiểu codebase như senior lâu năm — không đoán convention,
không bịa file, không bỏ sót touchpoint, và **kiểm tra lại thật sự** khi được yêu cầu.
Đặc tả đầy đủ: [`docs/LARAVEL-CRAFTSMAN.md`](docs/LARAVEL-CRAFTSMAN.md).

## Cài đặt

1. Copy folder này vào `~/.ezcode/extensions/laravel-craftsman/` (hoặc Settings → Extensions → Install → local folder).
2. Bật extension trong Settings → Extensions.
3. Cấu hình **Planner model** (bắt buộc cho `laravel_plan`) — Settings → Extensions → Laravel Craftsman.
4. (Tùy chọn) **Verifier model** — nên khác hãng với planner (phản biện chéo). Bỏ trống = dùng planner model.

Yêu cầu: repo Laravel (có `artisan` + `composer.json`) + PHP trong PATH (hoặc đặt `php_bin`).

## Tools (7)

| Tool                  | Chức năng                                                                                                                                                                                     | Deterministic          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `laravel_fingerprint` | Chân dung dự án: version, packages, conventions (log, FormRequest, Sanctum, Pest, structure)                                                                                                  | ✅ 100%                |
| `laravel_schema`      | Bản đồ DB từ migrations: bảng, cột, enum, FK                                                                                                                                                  | ✅ 100%                |
| `laravel_contracts`   | ★ blade ↔ JS ↔ routes: selector/url đối chiếu route thật + DOM → 🔴 broken links                                                                                                              | ✅ 100%                |
| `laravel_plan`        | ★★ Pipeline đầy đủ: 3 prompt-critics → hỏi làm rõ → explorer → 5 planners song song → hội đồng → critic deterministic (hallucination/checklist/claim/contract-diff) → plan + score + unknowns | ⚠️ LLM + deterministic |
| `laravel_reverify`    | ★★ RVP 3 kênh (deterministic + adversarial fresh-eyes + reality) → báo cáo per-item ✓/✗/?                                                                                                     | ⚠️ LLM + deterministic |
| `laravel_audit`       | Dead code 3 mức (🔴 broken / 🟡 possibly-dead / 🟢 used) — alive-set từ routes                                                                                                                | ✅ 100%                |
| `laravel_trace_flow`  | Trace workflow end-to-end: selector/url/route → handler → controller → response, mỗi mắt xích ✓/✗                                                                                             | ✅ 100%                |

## Tự động (events)

| Event       | Hành vi                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`     | **Triage mọi prompt** (heuristic 0 chi phí, optional LLM refine) → feature phức tạp: ép gọi `laravel_plan`; bugfix: ép trace ngược; "kiểm tra lại": ép gọi `laravel_reverify`; câu hỏi: ép trả lời có evidence |
| `tool_call` | **Gate strict mode**: chặn edit khi yêu cầu phức tạp chưa explore/plan                                                                                                                                         |
| `agent_end` | Auto-RVP gọn (deterministic + verifier) + lưu episode (learning)                                                                                                                                               |

## Kiến trúc

```
index.js                    # factory + events (triage/gate/agent_end) + panel
lib/
├── cbm.js                  # bridge code graph CBM (copy từ code-reader)
├── llm.js / cache.js       # gọi model theo vai · cache mtime-based
├── exec.js / context.js    # artisan an toàn · resolve Laravel root
├── gap-registry.js         # ★ sổ nợ hiểu biết: 3 đường explore/ask/unknown
├── understanding-map.js    # ★ verified/inferred/unknown + guardrail
├── memory.js               # ★ episodes + learned checks + knowledge (JSONL)
├── stages/
│   ├── triage.js           # intent×scope×level + transform prompt
│   ├── prompt-critics.js   # ★ 3 subagent song song → Requirements Map
│   ├── explorer.js         # ★ active explorer (đọc có mục tiêu, facts)
│   ├── planners.js         # ★ 5 vai song song + hội đồng merge
│   ├── critic.js           # ★ blocking/advisory + claim verification
│   └── rvp.js              # ★★ RVP 3 kênh độc lập
└── laravel/
    ├── routes.js + routes-fallback.js  # route:list + fallback parse web/api
    ├── schema.js / fingerprint.js / blueprint.js
    ├── contract-diff.js    # ★★ cross-layer set-diff blade↔JS↔rules↔controller
    ├── trace-flow.js       # chuỗi mắt xích workflow
    ├── audit/dead-code.js  # alive-set + 3 mức
    └── frontend/           # blade-graph / js-extract / contract-match
tools/                      # 7 tools (1 file 1 tool)
__tests__/                  # 60 tests + fixture repo Laravel
docs/LARAVEL-CRAFTSMAN.md   # đặc tả đầy đủ
```

## Trạng thái milestone

- [x] M0 — spike foundations + parser scan
- [x] M1 — ground truth: fingerprint + schema + routes + frontend contracts
- [x] M2 — triage intent×scope + gap registry
- [x] M3 — prompt critics (3 subagent) + clarification + understanding map
- [x] M4 — active explorer + cross-layer contract diff
- [x] M5 — 5 planners + hội đồng + critic + gate
- [x] M6 — dead code audit (alive-set + 3 mức) + trace_flow
- [x] M7 — RVP 3 kênh + enforcement hooks (gate + auto-RVP)
- [x] M8 — learning loop (episodes, knowledge, learned checks — wire qua reverify/plan)
- [ ] **Eval trên repo thật của bạn** — bắt buộc trước khi dùng production

## Test

```bash
node --test extensions/laravel-craftsman/__tests__          # 68 tests
node extensions/laravel-craftsman/__tests__/smoke-pipeline.mjs  # demo pipeline với fake LLM
```
