# Revision 2 — launcher, evidence and answer size

Historical r2 notes. `REVISION-3.md` supersedes these runtime, interaction-policy, diagnostic and browser-gate instructions.

This revision remains based on c035fc9. The ZIP provides both a cumulative `repair.patch` for a clean c035fc9 tree and `revision-2-only.patch` for the previous 628c286 bundle now on staging. Apply only one, to the matching tree. Preserve the operator identity differences as before. No live deployment is included.

## Corrections

1. **Read interpreter.** The previous bridge could mistake a shell launcher's shebang for a Python interpreter. `JARVIS_LOOKUP_PYTHON` now explicitly selects the existing engine virtualenv Python. It must be an absolute path and identify itself as Python 3. Without it, only a checked Python beside the engine or a direct absolute Python shebang is eligible. `/bin/sh` is rejected before the helper runs. No shell launcher body is parsed or executed. A sibling wrapper explicitly named `python` must also pass the Python probe. This preserves the existing search backend/home and never launches a general agent.
2. **Evidence.** API and browser probes share `tools/generative_evidence.py`. It reconstructs tokens and every authoritative `text` replacement, parses actual top-level fences (backticks or tildes, `openui` or `openui-lang`), retains full program bodies, and distinguishes unlabelled Lang/code from declared UI. A code fence alone does not prove a renderer mounted it. JSON retains provisional text, all text revisions, the final answer and raw events. The API recorder also saves `.sse` files and a readable `.answers.md` alongside its JSON. Both runners use the server verdict rather than requiring UI for every answer.
3. **Terminal verdict.** Text turns now emit `done.status` (`ok`, `partial`, `failed`, `cancelled`) plus `evidence_version: 2`. This final verdict overrides provisional signals in the recorder. Legacy `note.partial: true` is still honoured; missing status is explicitly unknown, never inferred from a missing UI event. A rejected UI includes a redacted validation error in the non-display note event, so the next real run can explain the failure. Voice's done payload is unchanged.
4. **Over-composition.** Prose is now the default. Greetings/acknowledgements get one brief plain sentence; short explanations, explicit plain/sentence-count requests and native code/table requests do not get demonstration controls. The unconditional instruction to append a program is gone. Plain examples precede the optional component catalogue, and a closing rule makes clear that its root/verification requirements never apply to prose. A prior RAM discussion does not authorise an unasked calculator after “Hello”. There is no keyword router or hardcoded greeting reply; real model compliance must be checked after application.

## What the current staging answers show

`evidence/answers-30-before.md` and `.json` contain the full actual answers and timings for all 30 frozen questions on the **previous** staging revision. Twenty-seven are recovered verbatim from their stored sessions. The other three (g09, g18, g29) were not present in that stored run and are clearly labelled new repetitions on the same build, with their new timings. Do not substitute those timings into the operator's original 398-second total. Stored sessions do not retain the server's terminal verdict, so their status is unknown.

These answers do not support dismissing all the old partial reports as counter errors. The recovered final answers are predominantly prose-only. A new pricing probe streamed a calculator and then sent `note.partial: true` followed by a prose-only authoritative `text` answer. That wire evidence is included. The later 1,069-character greeting in the RAM conversation contains an **unlabelled** calculator fence; that is not a declared OpenUI program the parent would mount. The shared recorder reports it as unlabelled code, not as a successful interface. The revised terminal verdict and validation errors make that distinction inspectable without screenshots or counters being treated as answer evidence.

No after-revision-2 staging answer is claimed. Application requires the operator's shell access. The new prompt's quality is not established by scripted local providers.

## Stage-only commands

Use the same staging checkout/service/home. Before starting that service, set its process environment to the actual existing engine virtualenv interpreter:

```sh
export JARVIS_LOOKUP_PYTHON="$STAGING_ENGINE_PYTHON"
```

This is the engine Python that successfully imported the already verified `search(query, limit)` and `extract(urls)` functions. It is not `/bin/sh`, a new venv or a different backend. Do not write provider credentials into arguments, patches or reports.

Smoke-test using the same environment as the service:

```sh
python3 - <<'PY'
import os, response_lookup
engine = os.environ['CONFIGURED_STAGING_HERMES_BIN']
print('Interpreter:', response_lookup.resolve_python(engine))
print(response_lookup.run(engine, 'web_search', {'query': 'Python 3.14 release notes site:python.org'}))
PY
python3 tools/verify_intelligent_ui.py --browser "$CHROMIUM" --report "$EVIDENCE_DIR/offline-r2.json"
```

`CONFIGURED_STAGING_HERMES_BIN` is the existing configured launcher path, supplied by the operator; it is not a new app setting. Apply the patch and start/restart only staging through its existing workflow. The frontend JS/CSS/runtime bytes do not change in this revision, so those build stamps alone cannot identify the backend revision. Require `evidence_version: 2` and `done.status` on a fresh text turn.

Run **one** full browser batch; it keeps the full model answers in `browser.json` and exercises real mounted controls/images:

```sh
node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/model-browser-r2" --allow-cancel
python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/model-browser-r2/browser.json" --report "$EVIDENCE_DIR/model-browser-r2/answers.json"
```

The second command spends zero model turns and creates `answers.answers.md` with all answers, programs/prose and timings. It retains the original recorder errors separately. Return that Markdown, the JSON, and screenshots. Do not return only pass counters. Browser timing includes a separate `model_seconds` field for send-to-stream-completion latency; overall `seconds` includes page/media checks too.

If no browser is available, record the 30 actual API answers once instead:

```sh
python3 tools/generative_probe.py --base https://stage.battemohammad.com --cookie-file "$REVIEW_COOKIE_FILE" --report "$EVIDENCE_DIR/api-r2.json" --allow-cancel
```

That produces `api-r2.answers.md`, JSON and a wire directory. It proves answer generation and server status, not browser rendering. Existing previous JSON reports can be replayed with `--replay` without any credentials or model calls; real legacy partial flags will remain partial. A legacy completion without an explicit verdict remains unknown.

First inspect g01 (one plain greeting), g02 (two plain sentences), g03 (concise explanation), g06–g08/g11 (loaded subject photos), g12–g14 (appropriate essential-detail collection), g17 (288,000 to 360,000 locally), g25–g27 (native code/table). Then inspect every other full answer. A terminal partial requires its `presentation_errors` and provisional/final text to be examined, not relabelled as success. Public inline questions must retain zero task-agent starts. Real streaming interaction and the hosted reference comparison remain separate required checks. **Do not deploy live.**

## Test changes disclosed

Added 11 evidence/launcher tests, including real worker terminal status, authoritative replacements, multiline SSE, tilde fences, unlabelled code, legacy unknown/partial, shell rejection and explicit interpreter selection. The routing harness now imports the real `NOISE` constant; previously a short fake answer could fail with a missing test-global while the route-only assertions still passed. All 40 routing cases now also require successful turn completion except the intentional failed-lookup case. No questions/settings or expected model actions changed in this revision. Only the reviewed `stream` postimage changed in the protected-boundary fixture. SDK assets, legacy widgets, approvals, voice prompts/grants and private identity lines are unchanged.
