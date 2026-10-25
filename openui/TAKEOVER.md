# Text UI repair from c035fc9

Revision 1 handoff retained for history. For the current revision, use `REVISION-2.md`; its launcher configuration, terminal verdict and evidence instructions supersede the corresponding sections below.

Base: `c035fc9993b62a5c4f720c838bca165b52e22588`. Apply to the confirmed snapshot, not an older HEAD or a reconstructed tree. No live deployment is included or authorised by this handoff. Voice stays paused. The operator publishes only after the remaining staging and visual gates pass.

## Concrete causes and changes

* Text requests containing `show`, `compare`, `price` and similar words were sent to Hermes before the generative presenter ran. Text now starts with the general model, which can choose prose, a composition, missing-detail fields, public reads, or explicit guarded task delegation. There is no list of prompt-specific templates or runtime matches for the 30 review questions.
* The text agent still inherited instructions to construct files, PDFs and screen artifacts. Its text-only task prompt now asks for the authorised findings and reserves downloadable files for an actual file request. Voice's prompt output remains pinned.
* Public research no longer needs a general agent capable of creating files. `response_lookup.py` and `tools/presentation_lookup.py` call only the existing engine's search/extract functions in its configured interpreter/home. HTTPS/public-address checks, fixed tool names, JSON-only arguments, call/time/size limits and cancellation apply. Provider credentials remain on the operator's server. This new bridge requires a smoke test with the installed Hermes version; its interface is not verified by a local stub test.
* `/api/openui/runtime` used the live host in its frame policy on staging. The actual staging response confirmed `frame-ancestors https://live.battemohammad.com` and `X-Frame-Options: DENY`. The frame now binds its CSP/handshake to its own request origin and supplies `SAMEORIGIN` so the middleware does not add DENY. Asset-version, nonce, opaque sandbox and authenticated-read checks remain.
* Receipt metadata was injected into streamed bytes but omitted from the answer being validated. Valid sourced charts could therefore enter repair. One transport now produces both copies, including repairs, and rejects model-authored receipt metadata.
* Invalid programs were appended to rather than replaced; repairs could trigger an indexing error. Validation now supplies parser diagnostics, repairs are bounded to two attempts, and a successful repair replaces the rejected block through the existing SSE `text` event. The client now paints that authoritative text on the text answer surface.
* Frame failure was permanent. It now hides the failed program, accepts later revisions, and restores the edited OpenUI state. Recovery acknowledgement uses a timer: hidden iframes can suspend animation frames. No apology or raw Lang is inserted below an otherwise useful answer.
* Photo requests beyond the first three could be dropped. Twelve bounded requests now queue with three concurrent. Completion tracks actual image load/error, not just search completion. Turn badges reflect FINISHING/PARTIAL and can recover; a server-reported partial cannot be cleared by a successful UI acknowledgement.
* The actual SDK primitive catalogue now receives general composition guidance and examples for local recomputation, missing details, media, illustrations and reveals. Explicit sentence counts and ordinary prose/table/code requests remain supported.
* Both native and OpenUI table header taps preserve values and row order. That fix already existed in c035fc9; this patch adds browser coverage and does not reintroduce sorting.

## Validation and its limits

The untouched base passed 13/15 offline suites. Its failures were an all-tools-strict assertion contradicted by its own `emit_composition` schema, and a stale boundary fixture. The repair passes 18/18 suites with Chromium, including 15 new Python mechanism cases and 22 OpenUI browser cases. Local browser output and image bytes are fixtures. Native integration, semantic routing/setting enforcement, guarded child failures, receipt security and voice prompt/grant checks also pass. Two excluded-plugin tests skip; a private-persona hash is conditional on that excluded file.

Actual staging API baseline, build `45b7efe3c7` / `1522a5eb57`, recorded before application of this patch:

| Case | Seconds | Observation |
| --- | ---: | --- |
| g01 greeting | 5.37 | Completed as prose |
| g02 explicit two sentences | 9.59 | Attempted unnecessary UI, reported partial, final text only |
| g03 RAM/storage | 15.51 | Attempted UI, reported partial, final text only |
| g04 tyre-pressure checklist | 45.93 | Entered the general agent, did not finish; the probe cancelled only its returned turn and stopped |

No after-patch staging model output exists yet. No speedup or model-quality parity is claimed. The public demo at `https://www.openui.com/demo/intelligent-ui` showed Site Unavailable in the available browser after one reload. The pinned reference source was inspected; that is not a browser comparison with the hosted demo. The 30 questions were frozen before the baseline run, with SHA256 `89752dffd4eae2035bae883a8b4329b80e19b01f493a9a41ddffe4a609245e1c`.

## Disclosed test maintenance

* `routing40.json`: retains the 40 questions and settings. Public read/no-memory/ambiguous questions no longer expect a keyword or setting to force an agent. Its new `model_action` field scripts a provider tool decision **in the test harness only**. Private reads still expect the guarded agent. All text cases must first reach the presenter. Web Always still fails if the scripted provider never reads, and memory Off checks that no private-profile canary enters the request.
* `routing40_driver.py`: records scripted `web_search` and `request_task` calls and stubs the public read boundary. Cold-child failure tests still force a guarded task. The supplied-chart raw-question boundary test now explicitly forces the task boundary it tests.
* `test_intelligent_ui.py`: checks the new text-only task instructions and conditional file handover, retaining the voice/schema baseline checks.
* `test_response_authoring.py`: existing typed tools stay strict; only the already non-strict composition tool is exempt. An empty provider failure now raises to the worker's failure path instead of returning an empty partial. Successful emission and invalid-payload assertions remain.
* `defect6-boundaries.json`: rebased on exact c035fc9. Thirteen protected legacy files have identical before/after bytes. Exactly four server symbols change: `front_stream`, `hermes_answer`, `stream`, `openui_runtime`. All other symbol hashes stay at the base. Native painter postimage is updated for authoritative text and turn status; inline engine scripts are unchanged. `response_sources.py`, `response_authoring.py`, approvals, legacy widgets, warm agent and frame store remain unchanged.
* Native failure assertions now require readable text plus a partial marker, without expecting the removed apology. Added queue, repair recovery and native/OpenUI table tests.

## Jarvis: apply and test staging only

Use the operator's existing staging service environment, interpreter and engine home. Do not invent a new model key, change configuration, enable auto approval, touch live, revoke credentials during the run, delete history or pair devices. This bundle's patch has no runtime-state files.

1. In a clean c035fc9 review checkout, run `git apply --check /absolute/path/repair.patch`, then `git apply /absolute/path/repair.patch`. Copy only the reviewed application changes to staging using the existing staging workflow. Preserve the operator's eight identity redactions/differences in `server.py`. Generated JS/validator/prompt/page bytes are included; npm is needed only for rebuilding from source.
2. Run the read-bridge probe below with the **interpreter beside the configured staging HERMES_BIN** and the same staging service environment (especially HERMES_HOME). Do not use the live engine home. Return raw output. If imports/signatures do not match or the backend returns an error, stop here and return it; do not silently route public questions back to the general agent.

```sh
"$STAGING_ENGINE_PYTHON" tools/presentation_lookup.py --probe
```

The expected search signature accepts `query` and `limit`; extract accepts `urls` and may be async. A smoke test of the actual bridge, using the configured executable, spends one public search and no chat/agent turn:

```sh
STAGING_HERMES_BIN="$CONFIGURED_STAGING_HERMES_BIN" python3 - <<'PY'
import os
import response_lookup
result = response_lookup.run(os.environ['STAGING_HERMES_BIN'], 'web_search', {'query': 'Python 3.14 release notes site:python.org'})
print(result)
PY
```

3. Start/restart **only the isolated staging application** using its existing service. Record `/healthz`, `/build`, frame CSP and X-Frame-Options. Expect page JS `1dc2b69363`, CSS `1522a5eb57`, OpenUI asset `2f2c4c84b37179972aac7824e992646418f4cafb3d8dafac8a27398ea4f2afd0`. The runtime must allow the staging origin, and the browser must load that exact runtime. No test with an unavailable frame counts as UI evidence.
4. From the patched checkout run the suites. Set paths to actual installed executables; no package shim is included in the patch. Playwright is a browser-test dependency only, not an app/runtime dependency.

```sh
python3 tools/verify_intelligent_ui.py --browser "$CHROMIUM" --report "$EVIDENCE_DIR/offline.json"
node tools/native_openui_acceptance.js --browser "$CHROMIUM" --report "$EVIDENCE_DIR/native-openui.json"
```

5. Put the review cookie in an owner-only file containing `jl=...` (never in command arguments, commits or reports). Run the actual staging text-composer/browser gate; it reads all 30 frozen questions, starts fresh conversations, records provider SSE and UI completion, and captures true 390/320px reflow from the same answer. It uses the existing model behind `/stream`, not a local provider key. It permits only its page's normal conversation saves/creation, read requests and explicitly enabled cancellation of its own returned turn. Device/pairing, `/art`, configuration and other writes are blocked. An incomplete turn stops the batch. It does not clear test history.

```sh
node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/model-browser" --allow-cancel
```

The browser runner was syntax-checked and its selectors/protocol were inspected against this repository; it has not been executed against patched staging. Failures must be returned, not edited out or replaced with fixtures. The optional API-only recorder is `python3 tools/generative_probe.py --base https://stage.battemohammad.com --cookie-file "$REVIEW_COOKIE_FILE" --report "$EVIDENCE_DIR/api.json" --allow-cancel`. Running both full runners spends 60 turns; prefer the browser runner once.

6. Compare those same 30 questions with the reachable hosted reference demo. Keep before/after screenshots, answer/interaction choice, sources/images, mobile layout, control behavior and latency per case. If the demo is still inaccessible, mark the comparison **unverified**, not passed. Different providers do not imply identical wording, but inert controls, absent requested photos, guessed essential details, generic apologies, raw Lang/JSON and unneeded header sorting are failures.
7. Manually edit an input while a real staging answer is streaming; verify focus/value and dependent totals survive the final answer and any repair. Try a generated missing-details form: submission must prepare a draft and must not auto-send it. Return raw reports, logs, screenshots and build stamps. A green mechanism report alone is not a qualitative sign-off. **Do not publish live as part of these commands.**

Known separate limits: voice, external restarts and intermittent empty private-agent turns are not established; OpenUI state is not yet checkpointed across reload. Maps/video/arbitrary HTML remain outside the current local primitive catalogue. No claim is made that DeepSeek reproduces a different provider's hosted demonstration exactly.
