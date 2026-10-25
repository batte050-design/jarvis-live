# Revision 3 — service validator, required interactions and browser batch

Same public base: c035fc9. Use `revision-3-only.patch` on the r2 bundle (`f6db487`) already on staging, or `repair.patch` on a clean c035fc9 copy. Apply only one. Preserve the operator's identity lines. No live deployment is included.

## What the new wire evidence proves

Three fresh real-model turns against r2 staging were captured before this revision:

| Case | Seconds | Actual server result | Local validation of the captured program |
| --- | ---: | --- | --- |
| g06 building photographs | 12.791 | partial; Node executable missing | Compiles unchanged |
| g18 bill split | 13.263 | partial; Node executable missing | Compiles unchanged |
| g21 supplied weekday chart | 11.476 | partial; Node executable missing | Optional `currency: null` slot also rejected by the old guard |

All three wire captures contain `note.presentation_errors: ["[Errno 2] No such file or directory: 'node'"]`. They are included under `evidence/` with complete provisional and final answers. A throwaway shell's green Node tests did not establish that the app service could find Node. Model grammar repairs could not fix that environment failure.

## Changes

* **Explicit service Node.** `JARVIS_OPENUI_NODE` selects the stable installed Node executable. Otherwise the app checks `node`/`nodejs` on its actual process PATH. The minimal validator preflight compiles a real 52-component program. Missing executable/asset/process failures are distinct from invalid model code. Infrastructure failure skips the two paid grammar-repair attempts.
* **Preflight before model spending.** Authenticated, same-origin `GET /api/openui/health` checks the running service's validator and reports the runtime asset and evidence version. Both runners stop before sending a question if it fails. The existing `/healthz` liveness route stays unchanged. `tools/openui_preflight.py` supplies the corresponding operator CLI check.
* **Correct optional arguments.** A null positional placeholder in an optional slot is accepted as the default, matching the existing reference components' fallback behavior. This fixes the captured numeric chart with an explicit height and no currency. Required null properties, fabricated chart rows and unowned receipts still reject. The error names the invalid property rather than just its component.
* **Interaction policy.** A quote, bill split/tip, budget, adjustable scenario, requested photo, supplied-data chart or interactive lesson must deliver its relevant composition. A single initial total does not fulfil a quote. All scenario inputs should be editable, including bill amount/people/tip and quantity/rate/discount. Greetings, acknowledgements, isolated arithmetic facts and explicit plain answers remain concise prose. This is a general model policy with a generic example, not a question-id router or a canned quote emitter.
* **Diagnostics on every partial path.** Provider, read, validator and repair exceptions emit redacted structured diagnostics immediately. Final partial/failed text turns also carry a nonempty `done.presentation_errors`, and `done.presentation_diagnostics` preserves the phase/code/message. Interruption before any fence no longer produces an unexplained partial. Successful recovery does not inherit a transient partial verdict. Evidence version is now **3**.
* **Provider stream robustness.** Null continuation fields do not corrupt a tool call. SSE envelope overhead is bounded separately from the actual answer's 96 KiB limit. Aborted/length/content-filter/resource finish reasons are diagnosed instead of treated as clean completion. These changes have protocol fixtures; they are not asserted to be the missing-Node root cause observed above.
* **Real browser harness execution.** The hidden legacy voice switch caused the g01 setup failure; normal composer submission already arms text mode. The harness now uses that visible path. Cancellation requires an actual matching request conversation and a verified tid, then sends `{tid: ...}`; no numeric turn is needed. Missing identities stop nothing. Cancellation failure is secondary data and cannot erase the original error. The API recorder uses the same identity rules. Setup/stream/render phases are recorded.
* **Mounted quality checks.** g17 requires a real quantity input and 288,000 → 360,000 after changing four to five. g18 requires editable bill and people, sets bill 200,000 / five people / zero tip, and requires 40,000 per person without another turn. The harness recognises the actual SDK's decimal-mode text inputs. A prose-only response or absent supplied chart fails these checks, even with `done.status: ok`.

## Required staging environment

Keep the working `JARVIS_LOOKUP_PYTHON` setting. Add **JARVIS_OPENUI_NODE to the staging service's process environment**, pointing to the stable Node binary that passes the suites. An interactive shell export alone does not change a separately managed service's environment. Do not point at a throwaway shim, disable server validation or alter the live service.

The operator can obtain the intended path in the shell where the suites pass:

```sh
command -v node
```

Apply that absolute path to staging's environment through its existing staging workflow. After applying the patch and restarting only staging, run in the same account/environment:

```sh
python3 tools/openui_preflight.py
```

Expect `ok: true`, the actual executable path and `components: 52`. The authenticated `/api/openui/health` must also return `ok: true`. The runners perform that HTTP check themselves; a failure sends zero model turns. This HTTP result, rather than a separate shell's PATH, proves the running service has the compiler.

New frontend JS: `99588b17d6`; CSS stays `1522a5eb57`; OpenUI runtime asset: `2dd2e8c4c8d4394fc0a0d62abf52634b97a822efa0f51176174edcd9a45d7150`. A fresh text stream must return `evidence_version: 3` and its terminal status/errors. Regenerated validator/frame/page assets are included.

## Run the targeted mounted gate first

Use the existing review cookie in its owner-only file and the existing Chromium executable. No provider key leaves the server.

```sh
node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r3-targeted" --ids g01,g06,g17,g18,g21 --allow-cancel
python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/r3-targeted/browser.json" --report "$EVIDENCE_DIR/r3-targeted/answers.json"
```

The replay spends no model turns. Inspect the full answers, mounted inputs/photographs/chart, local recomputation, screenshots at true 320/390px reflow and the terminal verdict. If a partial remains, return its **full `presentation_errors`, `presentation_diagnostics`, provisional text, text replacements and final answer**. Do not report only counters or repin a failure away.

Once those targeted cases pass, run all 30 frozen questions:

```sh
node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r3-all30" --allow-cancel
python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/r3-all30/browser.json" --report "$EVIDENCE_DIR/r3-all30/answers.json"
```

Return the readable `answers.answers.md`, JSON, screenshots and stamps. Check human edits during a real stream and the hosted reference comparison separately. No new deploy or publishing action is authorised by these commands.

## Local evidence and limits

The new integration test runs the **actual browser harness, actual production page, renderer, iframe policy and controls** against explicitly local HTTP/photo fixtures. It completes greeting/media/quote/chart cases with no numeric `open.turn`, replays the real r2 bill program and changes people to five (30,600), and exercises an editable-bill fixture (40,000). It also checks setup failure, invalid validator preflight with zero model spending, and failure of an owned tid-only cancellation. Screenshots in that test are fixture evidence and are not presented as patched staging screenshots.

`tests/test_revision3.py` covers explicit Node with empty service PATH, missing Node without paid repair, note/done diagnostics, interruption before a fence, the three actual captured programs, optional versus required null, cancellation identity, nullable tool fragments, SSE envelope overhead and aborted finish reasons. Existing receipt/approval/voice/table checks remain. Only `front_stream`, `stream` and the new read-only `openui_health` postimages change relative to r2 in the boundary fixture; the preimage remains the public c035fc9 baseline. The operator-identity `accounts` difference remains an expected private-tree mismatch; no identity pin was weakened or repinned to private values.

No after-r3 real-model staging result is claimed. The service environment must be corrected and the patch applied by the operator first. The captured r2 bill had a fixed bill amount; its local replay proves rendering, while the new prompt and g18 gate require all inputs to be editable in the new model answer. Voice remains paused, and live remains untouched.
