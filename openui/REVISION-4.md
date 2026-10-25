# Text UI revision 4 — staging handoff

Public base: `c035fc9993b62a5c4f720c838bca165b52e22588`.
Parent: r3 `1ebdc5ecd7b2db24933de4059688697d600eb384`.
No deployment or push performed by this revision. Voice stays paused.

## What was observed

Two fresh authenticated staging g18 turns on js 99588b17d6: one `ok` (8.946 seconds), one `partial` (15.293 seconds). The partial DID carry errors in both `note.presentation_errors` and `done.presentation_errors`. Its program put positional Text/Row arguments in the wrong slots, including a Text size only supported by Title. The error was truncated mid-message at 200 characters. These captures are included, rather than treating counters as proof.

The repair loop had a second defect: after a rejected repair it asked again about the original program instead of feeding back the new candidate's errors. R4 supplies up to 2,000 characters of compact validation reasons and feeds each candidate back into the existing maximum of two repair attempts. It asks for simpler valid composition while preserving the user's inputs/formulas. It does not coerce numbers, accept invalid schema, or add a topic-specific calculator.

R3's missing `frame-src 'self'` was our omission. R4 includes the policy correction and browser fixtures now execute the actual production page_response and enforced PAGE_CSP, instead of serving a bare parent page without its response headers.

Input, TextArea, Select and DatePicker have explicit id/label-for/aria-label associations. Slider always has a visible associated label. If a model omits a label, the bound state variable supplies a readable fallback, e.g. `$count` becomes Count; a generic fallback is used only where no binding name exists. Checkboxes/radios retain their native enclosing labels.

Browser validation/render failures now leave a visible short status plus bounded diagnostic metadata in the parent; the browser recorder saves `browser_presentation_errors`. These are client failures and are kept distinct from the server's SSE presentation_errors. Recovering a frame clears its old failure notice. A parent CSP rejection is also identified. No silent hiding-only path remains in the frame's failure handler.

## Apply exactly one patch

The archive includes full source, cumulative patch, and two r3 deltas. Preserve the operator's identity lines in server.py.

* On staging already carrying the operator's `frame-src 'self'` correction: apply `revision-4-staging.patch`. It excludes server.py, whose ONLY r4 change is that same CSP token.
* On unmodified public r3: apply `revision-4-only.patch`.
* On clean public c035fc9: apply `repair.patch`.

Run `git apply --check PATCH` before `git apply PATCH`. Do not apply multiple variants. Existing uncommitted operator changes must be preserved. The exact public protected-boundary fixture still differs from private operator identities; this revision does not weaken that pin.

Already-generated assets are included; a rebuild, if needed:

    npm --prefix openui ci
    npm --prefix openui run build
    python3 build_v1.py --target "$PWD"

Expected JS `f4cf3ef6c0`, CSS `1522a5eb57`, runtime `387199e37bebb32debedaf5f90fcad17e30b291c20140c87627571eaf619ade1`.
Keep JARVIS_OPENUI_NODE and JARVIS_LOOKUP_PYTHON configured in the actual service environment.

## Verification

Local evidence is explicitly offline: 22 suites, including real Chromium using enforced parent CSP; 24 native OpenUI checks; seven browser-harness checks; three captured-failure repair tests. The successful real r3 bill was replayed and edited to bill 200,000 / five people / zero tip => 40,000 each. This is not an r4 real-model result. All raw local suite output and both real staging wire captures are included.

After the owner applies r4 and restarts STAGING only, check authenticated `/api/openui/health` and `/build`. Then, using the existing private cookie and Chromium paths:

    python3 tools/verify_intelligent_ui.py --browser "$CHROMIUM" --report "$EVIDENCE_DIR/r4-suites.json"
    node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r4-targeted" --ids g01,g06,g17,g18,g21 --allow-cancel

Repeat g18 if needed to exercise model variability. Confirm quantity has a visible meaningful label; edit quantity to five => 360,000; edit bill to 200,000 and people to five with zero tip => 40,000. All edits must stay local. If a turn is partial, return its full wire events and browser_presentation_errors, not a count alone.

Only after the targeted cases pass, run the full thirty-question browser batch:

    node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r4-browser30" --allow-cancel
    python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/r4-browser30/browser.json" --report "$EVIDENCE_DIR/r4-browser30/answers.json"

The last command reconstructs readable answers without another model call. Return raw browser.json, answers.answers.md, build stamps and the browser's screenshots through the existing review channel. The staging `/api/dev/run` door can run its fixed suites/answers commands after application, but verify its report actually lists the new revision-4 and revision-3 suites; an old report listed only 19 suites. The API answer batch alone cannot prove controls mount.

The r3 ZIP in our workspace was indeed truncated; no claim about the cause is made. R4 is closed, reopened, every ZIP entry CRC-checked, extracted and byte-compared, and SHA-256 computed after completion. No model keys, review cookies, private identities or runtime state are included.
