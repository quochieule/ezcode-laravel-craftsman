# Laravel Craftsman — Extension "Senior Code Intelligence" cho Laravel

> **Trạng thái:** SPEC — ĐÃ CODE v0.2 (60 tests xanh). Đặc tả tổng hợp từ quá trình thiết kế (9 vòng phản biện) + triển khai M0–M8 cơ bản.
> Mục đích: để review trước khi bắt đầu M0.
>
> **Ý tưởng:** một extension riêng cho Laravel + Blade + jQuery/Ajax, làm cho ezcode hiểu
> codebase như senior lâu năm: lập kế hoạch đầy đủ touchpoint, tự phản biện (đủ chưa? có
> nên explore thêm không?), tự hỏi có bằng chứng (không bao giờ tự sáng tạo), và kiểm tra
> lại nghiêm túc khi được yêu cầu (không "xin lỗi" suông).

---

## 0. Tóm tắt 1 trang

Extension `laravel-craftsman` — toàn bộ (code + docs) nằm gọn trong folder `extensions/laravel-craftsman/` (docs: `extensions/laravel-craftsman/docs/LARAVEL-CRAFTSMAN.md`), sẵn sàng push lên git như 1 repo độc lập:

1. **Triage mọi prompt** (intent × scope) → rẽ nhánh pipeline đúng loại việc: feature / bugfix / question / reverify / refactor / optimize / trivial.
2. **Phản biện prompt** bằng 3 subagent song song (đọc yêu cầu / ngờ vực / đối chiếu session+codebase) → Requirements Map có nguồn → hỏi user đúng chỗ, có vết tìm, giới hạn vòng.
3. **Explore có nền tảng**: ground truth từ `php artisan` (routes, schema, version, packages) + code graph (CBM) + vertical chain checklist — mọi evidence có nguồn, không bao giờ đoán.
4. **5 subagent plan** song song (kiến trúc sư / frontend contract / data / security / risk) → hội đồng merge theo luật bằng chứng.
5. **Critic**: blocking/advisory, hallucination filter, claim-level verification (đọc lại code thật), cross-layer contract diff — plan chỉ chốt khi đạt gate, kèm UNKNOWNS khai báo công khai.
6. **Thực thi có guardrail** (chặn edit vùng unknown) → **verify Laravel-aware** sau task.
7. **RVP (Re-Verification Protocol)**: khi user nói "kiểm tra lại" → 3 kênh độc lập (deterministic + fresh-eyes subagent + reality) → báo cáo per-item ✓/✗/? — không bao giờ "trông ổn".
8. **Học**: lỗi user tìm ra → thành check mới vĩnh viễn; câu hỏi đã trả lời → không hỏi lại; convention học được → inject từ đầu phiên.

**Nguyên tắc bất biến:** mọi claim có nguồn · chỉ deterministic tạo gap (LLM không tự hỏi theo cảm giác) · không file thô vào bất kỳ LLM call nào · mỗi stage 1 context riêng, chỉ artifact đi qua biên giới.

---

## 1. Vị trí & ranh giới

|                       |                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Loại**              | Extension mới, code-first chuẩn pi-coding-agent (`index.js` export factory `(pi) => {}`)                             |
| **Chạy cùng**         | `code-reader` (mắt = knowledge graph CBM) — Craftsman copy bridge `lib/cbm.js` sang, không phụ thuộc code-reader bật |
| **Không sửa**         | Core ezcode, protocol WS, DB, session, extension khác                                                                |
| **Mục tiêu codebase** | Laravel (8–12) + Blade + jQuery/Ajax + PHPUnit/Pest. Không nhắm generic                                              |
| **Bảo mật**           | Extension chạy in-process, toàn quyền → từ security level `balanced`, cài xong mặc định disabled, bật tay            |

### Tại sao tách extension riêng, không nâng cấp code-reader

- Code-reader là tầng generic (mọi repo) — trộn logic Laravel làm hỏng tính tái dùng.
- Không đụng extension đã test kỹ, đang chạy tốt.
- Phân vai rõ: **code-reader = mắt** (đọc graph), **Craftsman = não** (lập kế hoạch + phản biện + ép quy trình).

---

## 2. Triết lý — 3 trụ

1. **Grounded** — mọi claim có nguồn, không có ngoại lệ: `code:file:line` · `artisan` · `session:msg N` · `frontend:file:line` · `contract:khớp/lệch` · ⚠️`assumption`. Không gắn được nguồn = tự động xếp `assumption` → khai báo công khai. Agent không bao giờ trình bày giả định như sự thật.
2. **Self-critical** — mọi bước tự vấn "hiểu đủ chưa?" bằng cấu trúc (gap registry, understanding map, claim verification, RVP). Kiểm tra phải độc lập: không bao giờ để người sản xuất tự kiểm tra sản phẩm.
3. **Adaptive** — triage trước khi làm; pipeline khác nhau theo loại việc; hệ thống biết khi nào nên bận rộn, khi nào nên im lặng.

### Luật chống "tự sáng tạo" (bất khả xâm phạm)

| Luật | Nội dung                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1   | Chỉ hệ thống deterministic được **tạo ra gap**. LLM chỉ được **chuyển gap thành câu hỏi** — không bao giờ tự sinh câu hỏi theo cảm giác "không chắc" |
| L2   | Không bao giờ tự sinh câu trả lời khi thiếu thông tin — thiếu = hỏi (có vết tìm) hoặc dán `unknown`                                                  |
| L3   | Hỏi code trước, hỏi người sau — mỗi câu hỏi cho user kèm bằng chứng đã tìm (search X, đọc Y, không có trong code)                                    |
| L4   | Không file thô vào bất kỳ LLM call nào (kể cả subagent, kể cả agent chính) — chỉ evidence pack đã chưng cất                                          |
| L5   | Không bao giờ khẳng định độ phủ giả — báo cáo thiếu danh sách "không kiểm tra được" là báo cáo thất bại                                              |

---

## 3. Kiến trúc tổng thể

```
extensions/laravel-craftsman/
├── index.js                    # entry factory (pi) => {} — wire events + register tools (mỏng, per-session)
├── manifest.json               # settings form (xem §11)
├── package.json                # metadata, zero runtime dep (v1)
├── lib/                        # process-shared (module cache dùng chung xuyên session)
│   ├── cbm.js                  # bridge CBM CLI (copy từ code-reader: binary resolve, project resolve, auto-index)
│   ├── llm.js                  # wrapper createModelsCollection — gọi model theo vai (planner/critic/verifier/triage)
│   ├── triage.js               # intent × scope classification (1 call rẻ) + transform prompt
│   ├── gap-registry.js         # sổ nợ hiểu biết: ghi gap, phân loại, ưu tiên, xử lý 3 đường
│   ├── understanding-map.js    # bản đồ hiểu biết: verified/inferred/unknown + nguồn
│   ├── evidence-packer.js      # ★ facts → packs theo vai, token cap cứng, đo lường
│   ├── session-reader.js       # đọc session qua ctx.sessionManager.getEntries() → facts có nguồn session:msg N
│   ├── memory.js               # episodes + memories + checklist updates (JSON per-workspace, pattern extension memory)
│   ├── laravel/
│   │   ├── fingerprint.js      # composer.json + artisan about + scan convention backend+frontend → JSON
│   │   ├── schema.js           # migrations / schema:dump → bản đồ bảng-cột-quan hệ
│   │   ├── routes.js           # artisan route:list --json → inventory route + middleware + controller@method
│   │   ├── frontend/
│   │   │   ├── blade-graph.js      # @extends/@include/@component/<x->/@yield/@section/@push/@stack → cây view
│   │   │   ├── js-extract.js       # selectors, urls, global functions, data-attrs từ blade + JS files
│   │   │   └── contract-match.js   # url→route (normalize/fuzzy/confidence), selector→DOM, route() resolve
│   │   ├── audit/
│   │   │   ├── alive-set.js        # string registries: routes, providers, schedule, events, observers, view()/route()/@include, JS urls/selectors
│   │   │   └── dead-code.js        # 3 mức 🟢 used / 🟡 possibly-dead / 🔴 broken
│   │   ├── blueprint.js        # ★ kiến thức tĩnh: 8 loại feature → vertical chain checklist
│   │   └── contract-diff.js    # ★ cross-layer set-diff: blade ↔ JS ↔ FormRequest ↔ controller ↔ response keys
│   ├── stages/
│   │   ├── prompt-critics.js   # 3 subagent song song + hội đồng 0 → Requirements Map
│   │   ├── explorer.js         # active explorer: vòng lặp agentic, ngân sách 25–40 bước
│   │   ├── planners.js         # 5 subagent song song + hội đồng merge
│   │   ├── critic.js           # blocking/advisory + claim-level verification + score + unknowns
│   │   └── rvp.js              # Re-Verification Protocol: 3 kênh + hợp nhất + báo cáo
│   └── panel.js                # setPanelSchema + publishToSession → dashboard
└── tools/
    ├── laravel_plan.js         # ★ feature → plan full-chain + confidence + unknowns
    ├── laravel_trace_flow.js   # trace workflow cũ end-to-end → bản đồ mắt xích + chỗ đứt
    ├── laravel_audit.js        # dead code 3 mức + broken links
    ├── laravel_contracts.js    # bản đồ blade ↔ JS ↔ routes (tra cứu)
    ├── laravel_schema.js       # schema hiện tại
    ├── laravel_blueprint.js    # checklist feature-type
    └── laravel_fingerprint.js  # convention đã phát hiện
```

**Lưu ý kiến trúc (đã xác minh từ source ezcode):**

- Entry `index.js` import cache-bust (`?v=mtime`) → **mỗi session 1 instance entry** (wire events riêng).
- `lib/*` resolve cùng URL → **module cache dùng chung** → state phải key theo workspace (`<workspaceHash>/`), có write queue + atomic rename (pattern SECOND-BRAIN §2.4).
- Settings đọc live qua `pi.settings.all()` → inject vào `ctx.extensionSettings` (pattern code-reader/get-advice).
- Windows-safe: `pathToFileURL` khi import; `execFile` không `exec` cho lệnh có output lớn; maxBuffer đủ cao (bài học ENHANCE.md).

---

## 4. Pipeline 8 bước

```
① TRIAGE (tự động, MỌI prompt — input event, 1 call rẻ)
   intent = feature | bugfix | question | reverify | refactor/audit | optimize | trivial
   scope  = backend | frontend | cả hai | không rõ
   mức    = trivial | vừa | phức tạp
   → trivial/question: không can thiệp (hoặc answer-mode)
   → phức tạp: transform prompt → ép agent gọi laravel_plan
     ⚠️ TRANSFORM CHỈ THÊM CHỈ THỊ — luôn giữ nguyên văn yêu cầu gốc của user
        (nối vào sau chỉ thị). Agent phải thấy goal để gọi laravel_plan(goal=...);
        nếu thay thế prompt gốc, agent không biết phải làm gì → từ chối.
        │
② PHẢN BIỆN PROMPT — 3 subagent SONG SONG (context riêng)
   A "Người đọc yêu cầu" · B "Kẻ ngờ vực" · C "Người đối chiếu" (session + codebase)
   → HỘI ĐỒNG 0 (1 context mới): Requirements Map
     { explicit[], ambiguous[], missing[], assumptions[], intent/scope + độ tin }
   mỗi claim kèm nguồn · 3 bên bất đồng intent/scope → xử lý phủ cả 2 khả năng
        │
③ XỬ LÝ GAP (gap-registry)
   intent gap (không có trong code) + blocking → hỏi user:
     kèm vết tìm · option khi có thể · ≤ 2 vòng · ≤ 5 câu/vòng · chỉ hỏi blocking
   hết vòng → đi tiếp với assumptions khai báo
        │
④ EXPLORE CÓ NỀN TẢNG (active explorer — §6.7)
   fingerprint + schema + routes + system map + vertical chain + analog
   mọi evidence: { touchpoint, files, nguồn } → understanding map cập nhật liên tục
        │
⑤ 5 SUBAGENT PLAN — SONG SONG (context riêng, pack riêng, cùng schema)
   1 Kiến trúc sư backend · 2 Frontend Contract ★ · 3 Data Layer
   · 4 Security & Auth · 5 Risk & Test
   → HỘI ĐỒNG (1 context mới): đồng thuận = chốt · bất đồng = theo bằng chứng
     · 1 bên thấy = kiểm chứng bắt buộc (không loại)
        │
⑥ CRITIC (deterministic làm xương sống — §6.10)
   🔴 blocking: hallucination (file/symbol tồn tại?) · checklist đủ? · contract lệch?
     · impact phủ? · claim sai (đọc LẠI code thật từng claim)
   🟡 advisory: lệch convention · test nhánh hiếm → unknowns, không chặn
   → score + UNKNOWNS (bắt buộc khai "chưa xác minh: X vì Y")
        │
⑦ GATE: đạt → chốt { plan compact, confidence, unknowns, evidence ref }
   chưa đạt → chỉ explore PHẦN THIẾU (mỗi vòng rẻ hơn, max 3–4 vòng, có lối ra)
        │
⑧ THỰC THI + RVP + HỌC
   guardrail sống (chặn edit vùng unknown) · verify Laravel-aware sau task (agent_end)
   · user hỏi "kiểm tra lại" → RVP (§6.12) · lỗi user tìm ra → học (§6.13)
```

---

## 5. Triage — ma trận intent × scope

| intent × scope                                | Pipeline                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| question                                      | Answer-mode: trả lời có evidence (trace hệ thống, trích file:dòng), không plan, không sửa |
| trivial                                       | Để agent làm luôn, không can thiệp (0 overhead)                                           |
| feature / backend                             | Chuỗi backend: route → controller → service → model/migration → policy → test → log       |
| feature / frontend                            | Chuỗi frontend: blade → JS → contracts → callback → DOM target                            |
| feature / **cả hai**                          | ★ Full vertical chain + **cross-layer contract diff** (bắt buộc)                          |
| bugfix / bất kỳ                               | ★ Trace NGƯỢC: triệu chứng → root cause → fix → verify theo scope                         |
| **reverify** ("kiểm tra lại", "còn thiếu gì") | ★ Short-circuit vào RVP — không plan mới, không giải thích lại                            |
| refactor / audit                              | Audit dead-code trước → plan dọn sau                                                      |
| optimize                                      | Đo lường trước → plan tối ưu                                                              |

**Calibration:** user correction ("không phải, tôi chỉ muốn...") → lưu (prompt gốc, nhãn sai, nhãn đúng) → hiệu chỉnh triage theo thời gian.

---

## 6. Các cơ chế cốt lõi

### 6.1 Source tagging

Mọi claim: `{ nội dung, nguồn }`. Nguồn: `code:file:line` · `artisan:<lệnh>` · `session:msg N` · `frontend:file:line` · `contract:khớp/lệch` · `framework:<version>` · ⚠️`assumption`. Không nguồn = assumption.

### 6.2 Gap Registry — sổ nợ hiểu biết duy nhất

Mọi stage ghi nợ: `{ id, loại, chỗ thiếu, bằng chứng đã tìm, ưu tiên, trạng thái }`.
Một bộ xử lý duy nhất, 3 đường theo thứ tự bắt buộc:

1. **Explore** — trả lời được bằng code? (search/đọc/trace/artisan)
2. **Hỏi user** — không có trong code + blocking, kèm vết tìm
3. **Unknown** — không chặn → dán nhãn, đi tiếp, khai báo trong plan

Phân loại gap bắt buộc: **intent gap** (ý người dùng) → hỏi · **evidence gap** (chưa đọc đủ) → explore · **contract mismatch** → phát hiện (không hỏi) · **conflict** (session mâu thuẫn prompt) → hỏi.

### 6.3 Understanding Map

```
{ item, status: verified|inferred|unknown, by: <nguồn>, checkedAt }
```

3 công dụng: (1) lái vòng explore — còn unknown blocking thì chưa chốt; (2) **runtime guardrail** — chặn edit vào vùng unknown; (3) hiển thị panel + nhận correction → học.

### 6.4 Ground truth Laravel (deterministic — không bao giờ đoán)

`composer.json` + `php artisan about --json` · `route:list --json` (routes + middleware + controller@method) · `schema:dump`/migrations · `migrate:status` · `model:show <Model>` (L11+).
Scan convention: `Log::` vs `logger()` vs `activity()` · FormRequest vs validate inline · Policy vs Gate · Service layer hay controller dày · Pest vs PHPUnit · CSRF setup (`$.ajaxSetup`?) · JS inline/stack/public · jQuery version · pattern confirm/toast/error.

### 6.5 Vertical Chain blueprint (per feature type)

```
JS handler → selector khớp DOM? → AJAX url khớp route? → CSRF đúng convention?
→ route + middleware → controller@method → FormRequest → service/repo
→ model + migration (khớp schema thật) → policy → response format
→ JS success/error callback (DOM target tồn tại?) → event/job → test → log convention
```

Mỗi mắt xích verify được ✓/✗. 8 loại feature v1: API endpoint mới · model + relationship · route có auth · job/queue · notification/mail · command · form/validation · báo cáo/query nặng.

### 6.6 Active Explorer

Vòng lặp agentic của riêng extension (execFile + LLM riêng, không xin phép agent chính):
mỗi vòng: quyết định cần biết gì → gọi tool thật (CBM search/trace/impact, đọc file, artisan) → xem kết quả → đi tiếp. Ngân sách hào phóng: 25–40 bước, cấu hình được. Checklist deterministic quyết định _phải phủ gì_, explorer quyết định _đi sâu đâu_.

### 6.7 Cross-layer Contract Diff ★ (task "cả hai tầng")

Set-diff deterministic giữa các tầng:

```
Blade field names ↔ JS $.ajax data keys ↔ FormRequest rules ↔ Controller $request
Controller response keys ↔ JS success callback keys
Migration cột mới ↔ Blade hiển thị ↔ Validation rule
```

Mismatch nào = 🔴 blocking. Model không bao giờ tự nhớ nổi ở codebase lớn — set-diff thì 100% chính xác.

### 6.8 Hội đồng subagent

- Stage ②: 3 critics (đọc yêu cầu / ngờ vực / đối chiếu) — output cùng schema
- Stage ⑤: 5 planners — output cùng schema `{ touchpoints[], files[], tests[], risks[], assumptions[] }`
- Merge: mỗi bên nêu bằng chứng cho bất đồng; "chỉ 1 bên thấy" → kiểm chứng bắt buộc, không loại
- Mỗi subagent: context riêng, pack riêng (evidence-packer), chạy `Promise.all`

### 6.9 Critic — blocking/advisory + claim verification

| Loại        | Ví dụ                                                                                                           | Hành vi                            |
| ----------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 🔴 Blocking | hallucination, broken link, contract mismatch, checklist thiếu, impact chưa phủ, claim sai sau khi đọc lại code | Bắt buộc iterate                   |
| 🟡 Advisory | lệch convention, test nhánh hiếm                                                                                | Ghi unknowns + đề xuất, không chặn |

**Claim-level verification:** critic mở file, đọc đúng method, xác minh từng claim quan trọng của plan — không chỉ check file tồn tại.

### 6.10 Dead code audit — 3 mức, chống false positive bằng Laravel magic

Alive-set từ string registries: routes (`'Controller@method'`), service container bindings, `$schedule->command('...')`, events/listeners string, route model binding, `view()`/`route()`/`trans()`/`@include`, JS urls/selectors. **Chỉ code chết sau khi đã loại hết alive-set.**

- 🟢 `used` — bằng chứng trực tiếp (route trỏ tới, selector khớp, có caller)
- 🟡 `possibly-dead` — không tìm thấy ref sau khi check toàn bộ alive-set + view graph (có thể sống: API ngoài, scheduled, chuỗi động) → LLM xét lại batch rẻ → trình user quyết định
- 🔴 `broken` — mắt xích đứt thật: JS gọi URL không có route · selector không có DOM ở đâu cả (đã check layout + partials + AJAX partials) · route trỏ controller@method không tồn tại

⚠️ Dynamic DOM: handler cho element render từ AJAX partial — selector không khớp DOM tĩnh KHÔNG = dead. Phải check toàn bộ view graph trước khi hạ mức.

### 6.11 RVP — Re-Verification Protocol ★

Trigger: (1) user hỏi "kiểm tra lại / còn thiếu gì / chắc chưa" → intent `reverify` → short-circuit (không plan mới); (2) auto sau task có sửa file (setting, mặc định on cho task không-trivial); (3) user nói "sai chỗ X" → trace ngược chỗ X → sửa → RVP gọn.

3 kênh ĐỘC LẬP:

1. **Deterministic ground truth** — chạy lại toàn bộ check cứng + test thật (`php artisan test`, `view:cache`, `route:list` smoke, `node --check` JS): bảng per-item ✓/✗, không có "trông ổn"
2. **Adversarial panel fresh-eyes** — 3–4 verifier (backend coverage / frontend contract / regression-edge-security / fresh-eyes reviewer): chỉ nhận plan + diff + file list, **KHÔNG thấy hội thoại gốc** (chống anchor); red-team prompt "tìm lý do sai, không đánh giá đúng"; báo cáo không phát hiện + không danh sách "không kiểm tra được" = thất bại; gap không evidence = loại
3. **Reality check** — chạy thật những gì chạy được (reality không xin lỗi)

Hợp nhất: 3 kênh cùng gap = chắc chắn · deterministic thắng LLM khi bất đồng.
**Báo cáo bắt buộc:** `✓ N xác minh · ✗ K thiếu (kèm file:dòng) · ? U không kiểm tra được (lý do)` — phần "?" không bao giờ giấu.

### 6.12 Learning — biến "xin lỗi" thành "thêm check"

- User tìm ra lỗi dù RVP đã chạy → không xin lỗi: xác định check nào thiếu → **thêm vĩnh viễn vào checklist** → memory episode → lần sau check trước.
- User correction / câu trả lời → memory (decision/preference) → không hỏi lại lần 2.
- Sau task: so plan vs reality (touchpoint nào thực tế phải đụng mà plan sót) → cập nhật checklist.
- Thước đo trưởng thành: số lỗi user phải tự tìm ra giảm dần theo thời gian.

### 6.13 Enforcement (ép quy trình, không mời gọi)

| Hook               | Hành vi                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call` gate   | Chặn edit vào vùng `unknown` / chưa explore đủ (strict mode, setting) — trả `{block: true, reason}`                                                                  |
| `agent_end` verify | Sau task có sửa file: chạy verify theo fingerprint (test filter, view:cache, route smoke) → fail → `sendUserMessage(followUp)` đẩy ngược agent (pattern verify-loop) |

---

## 7. Cô lập context — nguyên tắc artifact-passing

**Luật kiến trúc: mỗi stage là 1 context riêng; chỉ ARTIFACT (output compact) được chuyển tiếp; suy luận không bao giờ đi qua biên giới.**

### 7.1 Bản đồ cô lập

| Thành phần                                         | Sống ở đâu                            | Vào chat?                                                 |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| Đọc file, artisan, CBM query                       | Node fs / execFile — 0 token          | ❌                                                        |
| 3 critics, 5 planners, hội đồng, critic, verifiers | Mỗi cái 1 context riêng, dùng xong bỏ | ❌                                                        |
| Understanding map, gap registry, memory, episodes  | Storage JSON (disk, per-workspace)    | ❌ — panel                                                |
| Evidence packs                                     | Giữa các sub-context                  | ❌                                                        |
| **Plan artifact (compact)**                        | —                                     | ✅ duy nhất bắt buộc (collapsible tool call, ~1.5k token) |
| Fingerprint                                        | System prompt đầu phiên               | ✅ ≤ 500 token, tùy chọn                                  |
| Câu hỏi làm rõ                                     | Chat                                  | ✅ ≤ 5 câu, có vết tìm                                    |
| Lý do chặn gate                                    | Chat                                  | ✅ 1–2 dòng                                               |
| RVP report                                         | Chat (bản đầy đủ ở panel)             | ✅ compact                                                |

### 7.2 Ngân sách token (task vừa, cả 2 tầng)

| Thành phần                                      | Token | Context                               |
| ----------------------------------------------- | ----- | ------------------------------------- |
| Fingerprint                                     | ~400  | Main (1 lần)                          |
| Plan artifact                                   | ~1.5k | Main                                  |
| Agent đọc-để-sửa (5 file × 1–2k, có line-range) | ~6–8k | Main (sàn của agentic IDE — bắt buộc) |
| RVP report                                      | ~1k   | Main                                  |
| 3 critics + merge                               | ~12k  | Sub-context riêng                     |
| 5 planners + hội đồng                           | ~35k  | Sub-context riêng                     |
| Critic + claim verification                     | ~8k   | Sub-context riêng                     |
| RVP verifiers (3–4)                             | ~15k  | Sub-context riêng                     |

### 7.3 Evidence Packer

- Facts → pack theo vai, **token cap cứng** (cấu hình, mặc định 4–8k/call)
- **Vượt cap → tách thêm call, không bao giờ nhét quá**
- Log tokens mọi call vào metrics (panel hiển thị) — không có "ma thuật tiêu hao"

### 7.4 Chat vs Panel

- **Chat = nơi agent làm việc** (sạch, chỉ 5 loại artifact ở §7.1)
- **Panel = nơi extension giải trình** (map, gaps, packs, báo cáo realtime qua `publishToSession`)
- Cô lập không được thành bí mật — minh bạch nằm ở panel.

---

## 8. Data model — artifact contract

```jsonc
// triage.json
{ "intent": "feature", "scope": "both", "level": "moderate",
  "confidence": 0.8, "disagreement": false }

// requirements-map.json
{ "explicit": [{"claim": "...", "source": "session:msg 3"}],
  "ambiguous": [...], "missing": [...],
  "assumptions": [{"claim": "...", "reason": "chưa hỏi được"}] }

// gap.json
{ "id": "g-1", "type": "intent|evidence|contract|conflict",
  "what": "...", "evidenceSearched": ["search X", "read Y"],
  "priority": "blocking|advisory", "status": "explore|ask|unknown|resolved" }

// fact.json
{ "item": "OrderService@approve gọi OrderMail",
  "status": "verified", "by": "code:OrderService.php:42" }

// plan.json (schema chung mọi planner)
{ "touchpoints": [{"item": "route", "action": "existing|new", "file": "...", "reason": "..."}],
  "files": [...], "tests": [...], "risks": [...], "assumptions": [...] }

// critic-report.json
{ "blocking": [{"check": "contract-diff", "detail": "...", "evidence": "..."}],
  "advisory": [...], "score": 0.85,
  "unknowns": [{"what": "...", "why": "..."}] }

// rvp-report.json
{ "checked": 13, "verified": 12, "missing": [{"item": "...", "evidence": "file:line"}],
  "unverifiable": [{"item": "...", "reason": "..."}] }
```

Mọi stage output là JSON artifact — nhìn được, test được, diff được giữa 2 lần chạy.

---

## 9. Tools expose cho agent

| Tool                  | Chức năng                                                          |
| --------------------- | ------------------------------------------------------------------ |
| `laravel_plan`        | ★ Feature → plan full-chain + confidence + unknowns (pipeline ②–⑦) |
| `laravel_trace_flow`  | ★ Trace workflow cũ end-to-end → bản đồ mắt xích + chỗ đứt         |
| `laravel_audit`       | Dead code 3 mức + broken links                                     |
| `laravel_contracts`   | Bản đồ blade ↔ JS ↔ routes                                         |
| `laravel_schema`      | Schema hiện tại (bảng-cột-quan hệ)                                 |
| `laravel_blueprint`   | Checklist feature-type (tra cứu)                                   |
| `laravel_fingerprint` | Convention đã phát hiện (log style, test framework, structure...)  |

---

## 10. Settings (manifest.json)

| Field                  | Type         | Default | Ý nghĩa                                               |
| ---------------------- | ------------ | ------- | ----------------------------------------------------- |
| `model_triage`         | model_select | —       | Model cho triage (rẻ là được)                         |
| `model_planner`        | model_select | —       | Model cho 5 plan passes (mạnh nhất có)                |
| `model_critic`         | model_select | —       | Model cho critic/merge (khuyến nghị khác hãng nếu có) |
| `model_verifier`       | model_select | —       | Model cho RVP verifiers                               |
| `confidence_threshold` | number       | 0.8     | Ngưỡng chốt plan                                      |
| `max_plan_rounds`      | number       | 3       | Vòng plan-critic tối đa                               |
| `max_ask_rounds`       | number       | 2       | Vòng hỏi user tối đa (≤ 5 câu/vòng)                   |
| `explore_budget`       | number       | 30      | Ngân sách bước explore                                |
| `strict_mode`          | select       | true    | Gate chặn edit vùng unknown                           |
| `auto_rvp`             | select       | true    | RVP tự động sau task có sửa file                      |
| `pack_token_cap`       | number       | 8000    | Token cap mỗi evidence pack                           |
| `fingerprint_inject`   | select       | true    | Inject fingerprint vào system prompt                  |
| `cbm_bin`              | text         | —       | Đường dẫn binary CBM (kế thừa code-reader)            |
| `timeout_ms`           | number       | 120000  | Timeout mỗi lệnh artisan/CBM                          |

---

## 11. Chi phí ước lượng

| Bước                                                    | Gọi model                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Triage mọi prompt                                       | 1 call rẻ (~1–2s, intent=trivial thì dừng ở đó)                           |
| Plan đầy đủ 1 feature vừa                               | ~15–20 calls (3 critics + merge + 5 planners + hội đồng + critic + retry) |
| RVP đầy đủ                                              | ~5–10 calls + toàn bộ deterministic re-run                                |
| Phần deterministic (parser, diff, alive-set, checklist) | 0 — code thuần                                                            |

Chấp nhận được vì chủ đầu tư không giới hạn chi phí; vẫn có cap cứng mọi vòng lặp để đảm bảo termination.

---

## 12. Giới hạn — nói thẳng

1. **Không bắt được "thiết kế sai hướng"** (user muốn UX khác) — đó là intent, phải hỏi. RVP bắt thiếu sót coverage/factual, không bắt taste.
2. **Dead code không bao giờ 100%** — mức 🟡 là bản chất (API ngoài, scheduled, chuỗi động), không phải lỗi.
3. **RVP chỉ mạnh bằng danh sách check của nó** — learning loop (§6.12) là điều kiện sống còn, không phải tính năng phụ.
4. **Parser blade/JS phải calibrate trên repo thật** (selector ghép chuỗi, URL hardcoded đa dạng) — M0 bắt buộc scan source thật.
5. **Latency**: plan + RVP 2–5 phút — stream tiến độ từng bước, không "đang suy nghĩ".
6. **Main context có sàn ~10–15k/task** (agent đọc-để-sửa) — không thể thấp hơn trong agentic IDE; đã tối thiểu nhờ read list có line-range.

---

## 13. Non-goals (guardrail)

Không summarize chat · không embedding v1 (lexical/keyword trước) · không tự quyết định thay user · không tự sửa code ngoài agent chính · không hỏi lại điều đã trả lời · không chạy pipeline nặng cho task trivial · không sửa core · không nhắm non-Laravel.

---

## 14. Milestones (mỗi bậc tự đứng được, có gate)

| Bậc    | Nội dung                                                                                                                                                     | Gate                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **M0** | Spike: artisan calls từ extension (execFile + cwd), copy bridge CBM, `sessionManager.getEntries()`, 3 LLM song song, **scan parser blade/JS trên repo thật** | Parser đếm/khớp được selector+URL thực tế; 3 giả định chạy được |
| **M1** | Ground truth: fingerprint (backend+frontend) + schema + routes + system map                                                                                  | Đúng 100% với repo thật                                         |
| **M2** | Triage + intent taxonomy + answer-mode + trivial-pass + gap registry                                                                                         | Bắt đúng loại việc prompt giả lập; câu hỏi đúng trọng tâm       |
| **M3** | 3 prompt-critics + merge + clarification gate + understanding map                                                                                            | Bắt được prompt mơ hồ; hỏi có vết tìm; ≤ 2 vòng                 |
| **M4** | Active explorer + vertical chain + contract diff                                                                                                             | Coverage ≥ 90%; diff bắt mismatch giả lập                       |
| **M5** | 5 plan-passes + hội đồng + critic + gate + claim verification                                                                                                | 0 hallucination; plan sai bị critic bắt trong test giả lập      |
| **M6** | Dead code audit (alive-set + 3 mức) + `laravel_trace_flow`                                                                                                   | 🟡/🔴 khớp ground truth của user trên repo thật                 |
| **M7** | RVP 3 kênh + enforcement hooks + verify Laravel-aware                                                                                                        | "Kiểm tra lại" trả bảng per-item; chặn được edit vùng unknown   |
| **M8** | Learning (episodes, memory, checklist update) + eval 5 task thật                                                                                             | Sót touchpoint = 0; lỗi user tự tìm ra giảm dần                 |

**Eval M8 (giao thức đo):** 5 feature thật từ repo của user — chạy có/không extension, đếm: touchpoint sót, file bịa, lần vỡ sau sửa, số câu hỏi phải hỏi lại lần 2. So sánh với baseline trước khi bật.

---

## 15. Kịch bản demo (ca chuẩn — dùng cho M8 eval)

Prompt: _"thêm nút duyệt đơn cho admin, xong gửi mail cho khách"_ (sơ sài, cả 2 tầng).

1. **T+0s** — Triage: feature / cả hai / vừa → transform prompt ép gọi `laravel_plan`.
2. **T+2s** — 3 prompt-critics: Requirements Map; 2 câu hỏi thật (có nhập số tiền thực thu? mail template cũ hay mới?) — kèm vết tìm; user trả lời → memory.
3. **T+1'** — Explorer: `route:list` (orders.update, role:admin) · fingerprint (activity() + FormRequest + Pest + public/js/admin/orders.js) · schema (status enum đủ, không cần migration) · CBM trace (OrderController@update → OrderService@update → OrderMail chưa ai gọi 🟡) · blade order-detail có sẵn khối action + confirm modal convention · contract: orders.js đã ajax route('orders.update') ✓.
4. **T+2'** — 5 planners: Architect (approve() trong service) · Frontend Contract (nút + handler + confirm modal bắt buộc; CSRF đã setup sẵn) · Data (guard thiếu: không duyệt lại đơn đã duyệt) · Security (thiếu OrderPolicy@approve) · Risk (mail sync theo convention; thiếu test guard).
   Bất đồng: Architect đề xuất event OrderApproved — Risk phản đối (dự án chỉ có 1 event listener) → theo evidence: không event.
5. **T+3'** — Critic: 🔴 contract diff bắt: JS gửi `status: "approved"` nhưng OrderRequest thiếu rule status → phải thêm. Claim verification: đọc OrderService@update xác nhận transition ở service ✓.
6. **T+3.5'** — Chốt plan: 7/7 touchpoints, confidence 0.85, unknowns: "chưa kiểm tra mail template có biến $order — sẽ verify khi code tới".
7. **T+3.5→6'** — Agent thực thi: bị gate chặn 1 lần (sửa OrderController trước khi đọc OrderService) → đọc → tiếp. agent_end → pest ✓ · view:cache ✓ · route smoke ✓ · contract diff lại ✓.
8. **T+6'** — User: _"kiểm tra lại, còn thiếu gì không?"_ → RVP đầy đủ → báo cáo: 12/13 ✓, ✗ thiếu test cho guard "không duyệt lại đơn đã duyệt" → agent thêm test → xanh.
9. **T+7'** — Học: memory episode + checklist update ("transition → luôn check guard + test guard").

---

## 16. Rủi ro & mitigation

| Rủi ro                                      | Mitigation                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| Evidence packer kém → pack phình/mất signal | Token cap cứng + tách call + log metrics                                          |
| Subagent bịa gap (false positive)           | Gap không evidence = loại (deterministic filter)                                  |
| Verifier anchor vào plan sai                | Kênh 1 deterministic là anchor-free — trọng số quyết định đặt ở đây               |
| 2 session cùng workspace ghi đè             | State key theo workspace + write queue + atomic rename                            |
| Restart mất state                           | File-based JSONL, flush sau mỗi append                                            |
| Parser lệch repo thật                       | M0 scan + calibrate trên repo thật; regex theo pattern repo                       |
| Orchestrator quá phức tạp thành đống bug    | Deterministic làm xương sống; mọi stage JSON artifact; phát hành theo bậc có gate |
| User không tin hệ thống                     | Panel minh bạch + disable anytime + báo cáo per-item                              |
| Latency 2–5 phút                            | Stream tiến độ từng bước; triage trivial không overhead                           |

---

## 17. Cần chốt trước khi M0

1. **Auto-RVP**: mặc định bật sau mọi task không-trivial, hay chỉ khi user hỏi "kiểm tra lại"? (đề xuất: bật)
2. **Verifier/critic dùng model khác hãng** nếu có (phản biện chéo) — hay cùng DeepSeek mọi vai? (đề xuất: critic khác hãng nếu có)
3. **Browser E2E** cho verify frontend (phối hợp browser extension) — v1 hay để sau? (đề xuất: để sau, RVP v1 dùng deterministic + test)
4. Ngôn ngữ code/comment: tiếng Việt theo convention repo (đề xuất: có)
5. **Thời điểm chạy Stage ②–⑦**: chỉ khi agent gọi `laravel_plan` (triage transform ép gọi), không tự chạy nền — xác nhận.
