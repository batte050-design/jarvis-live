# Findings — observations separated from assumptions

## A. Every place that selects, restricts, repairs or substitutes the presentation

1. `page/driver.py:97-99` — injects `<page_turn_context>` and `<page_render_capabilities>`. This is the only place that tells the harness what it may emit per turn.
2. `plugin/prompt.txt` — the standing instruction contract (picture rules, precedence section).
3. `plugin/__init__.py:13` — `emit_ui` schema: "One initial attempt and one repair; never print the program as final text."
4. `plugin/__init__.py:51` — `emit_ui_twice_for_turn` refusal after acceptance.
5. `plugin/__init__.py:76` — validates the payload, stores the accepted record, writes `emission-<key>-<n>.json`, and truncates diagnostics to 800 characters per message, max 4 messages.
6. `plugin/openui_validate_once.py` — spawns the validator and, on rejection, appends a numbered positional signature generated from `validate.cjs --schema`.
7. `openui/src/guard.ts:8` — `validateProgram(code, final, receipts, harnessAuthored)`; the single gate for structural rules.
8. `guard.ts:25` — harness `Receipt(id)` must exist with rows, else reject.
9. `guard.ts:37` — harness `Image.src` must be a public HTTPS URL; local paths and credentials reject.
10. `guard.ts:38` — harness `SearchImage` rejects with a repair instruction.
11. `guard.ts:41` — the dated-receipt rule applies only when `!harnessAuthored`.
12. `openui/src/library.tsx` — component signatures; the `Chart` positional order the repair message quotes.
13. `page/driver.py:97` completion block — binds accepted record by session/turn/version and returns a distinct refusal code instead of a generic failure.
14. `page/legacy.py:156-176` — overlays stored turns (steps, status, error id) into the page's session list; does not rewrite answers.
15. `server.py:9391` — `/api/openui/runtime` refuses when `v` ≠ `asset_stamp()`.
16. `server.py:9404` — `/api/openui/images` (page-broker fallback; not used by the harness lane).

Nothing in the renderer substitutes a chosen image or rewrites an answer; the runtime paints what the payload declares.

## B. Observations (verified this session)

- The latest buildings answer succeeded: turn `2ca8828f00000081`, conv `0b1dccd066138994773966feb047fc26`, session `e3c4463e-da6a-4186-be93-c7608a23b089`, status ok, 15:10:08.
- Its accepted payload contains **10 `Image(` calls, 0 `SearchImage(` calls, 0 `Receipt(` references, `receipts: []`, `required: []`** — the harness-owned path in practice, not just in code.
- `guard.ts:41` gates the dated-receipt rule behind `!harnessAuthored`, so literal chart rows are legal on this lane and still illegal on the legacy lane.
- `response_openui.py:83` still contains "requested photographs MUST include SearchImage" and line 89 "Images: use SearchImage with the exact subject", while `page/driver.py:98` tells the same turn that "SearchImage is unavailable in this channel". Both strings reach the model in the same turn.
- The receipt writer truncates each diagnostic to 800 characters (`plugin/__init__.py:76`). Observed on turn `34a90c03b59f48d2a87dda55957781ab`, attempt 1, where the stored message ends mid-word at exactly 800.
- `/api/openui/runtime` compares `v` against `asset_stamp()` = sha256(openui-frame.js + openui-frame.css), a 64-hex value. The installer README's example passes the eight-character build stamp, which returns 404. Route is healthy with the correct value.
- The live worktree is dirty by design: modified `build_v1.py`, `index.html`, `index_v1.html`, `server.py`, `static/v1.css`, `static/v1.js`, `warm_agent.py`; untracked `openui/`, `DEFECT6.md`, `UI_REPAIR.md`, `.gitattributes`, `outbox/*`.
- The installed plugin is outside any git tree, so it has no upstream history of its own; the snapshot here is the only versioned copy.

## C. Assumptions (not verified)

- That the model weights the injected `<page_render_capabilities>` above the stale SearchImage sentences in `response_openui.py`. The successful turn is consistent with this, but one turn is not proof of the ordering.
- That the 15:10 success used no page-broker image fallback. `Image` URLs in the payload are public HTTPS, but I did not fetch each one to confirm the browser can load it.
- That no other writer produces presentation records for this owner. Only `page/` and the plugin touch that store as far as this snapshot shows; I did not exhaustively audit `server.py` for a second writer.
- That latency (84–105 s on failing turns, ~90 s on the successful one) is dominated by model/tool time rather than validation. No timing breakdown per stage exists yet.
- That `evaluate.cjs` in the plugin (1.37 MB, legal-fenced) is the pinned evaluator used by the validator. Its origin and licence terms are documented beside it, but I did not re-derive its provenance.

## D. Discrepancies between instructions, validator and renderer

1. **Instructions vs validator, same turn**: `response_openui.py` says photographs MUST use `SearchImage`; `guard.ts:38` rejects `SearchImage` for harness answers and `driver.py:98` says it is unavailable. The validator is right and the older instruction is stale.
2. **Instructions vs validator on receipts**: `response_openui.py:83` says supplied-data charts MUST be receipt-backed; `guard.ts:41` exempts harness-authored presentations and `driver.py:98` says receipts are optional. Again the older prose contradicts the installed rule.
3. **Receipt writer vs repair value**: the positional signature added to help repair is cut at 800 characters, losing the tail of the `Chart` contract it exists to communicate.
4. **Installer README vs route**: the runtime example uses the wrong variable (build stamp instead of asset stamp) and returns 404 by design.
5. **Page broker vs harness lane**: `/api/openui/images` still searches server-side, while the lane instructs the harness to supply exact URLs. Harmless while the harness supplies URLs, but it is a second image path that can produce different pictures.

## E. Page-tree plugin copy (added on request)

`page/plugin/` is a second, complete copy of the presentation plugin that lives inside the
application tree. It is **not** the copy that serves the live page: its `__init__.py` is
5,496 bytes with sha256 `9fc15dc4089350cc…`, which is the **preimage** of the receipts patch,
while the installed harness plugin at `/home/ubuntu/.hermes/plugins/page_presentation/__init__.py`
is 6,814 bytes with sha256 `9cc5a555f9aab084…` (postimage, receipts writer present).

Observation: the app tree carries a stale plugin. Assumption, not verified: `page/bootstrap.py`
resolves the plugin from the harness home rather than from `page/plugin/`, which is why the
receipts writer is live despite this copy being older. If anything imports `page/plugin/`
directly, it would run the version without emission receipts.
