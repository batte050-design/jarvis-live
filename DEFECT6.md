# Defect 6 — patch candidate, one remaining publication fault

Base: `eace50e404baeffadf87f77a096e7244728217dd`, the 23 October 2026 source export. This patch targets that exact tree. It does not reapply the eighteen repairs, four-defect changes or earlier response layer.

**Not a complete fix.** The full proof intentionally exits 1: `delayed_side_push_after_text_answer` still fails. The active text job is protected, but an unscoped `/art` push after that helper ends remains accepted. Making the boundary strict while preserving voice requires the missing module that implements `screen_show` and its `/art` request. That module is not in eace50e. This candidate is provided for review and reproducible diagnosis, not claimed as deployment-ready.

## Apply and run

On a disposable copy at eace50e:

```bash
git apply --check /absolute/path/01-defect6.patch
git apply /absolute/path/01-defect6.patch
python3 verify.py --cases tests/defect6_cases.json
```

That last command is the whole offline proof. It prints PASS or FAIL per case and exits nonzero on any failure. Python 3 and the Node executable already used by the repository's tests are required; no new runtime packages, account, browser access or network are needed. To retain raw diagnostics, append `--report /tmp/jarvis-defect6-proof.json`.

The source and generated page are included. The explicit rebuild command, if rebuilding the copy separately, is:

```bash
python3 build_v1.py --target "$PWD"
```

The builder was already corrected in eace50e; it is not patched again. Its regression now invokes the actual guarded builder against a source-only temporary copy, instead of expecting the retired hardcoded location. This avoids copying a deployed home, credentials, models or conversation store.

There is no `verify.py` in eace50e. This delivery adds one that runs the checked-in 40 JavaScript checks, 7 rendering repairs, 9 server tests, 13 authoring tests and the new defect cases. It is not claimed to be an unseen private verifier. The original authoring test also expected two `prompt_note()` call sites; this commit actually has three. The assertion now checks three, preserving all three.

## Findings established from this tree

CONFIRMED — `response_authoring.emit`, branch `emit_chart`, copies `points=arguments['points']`. Its function contract contains only title, chart and points. Neither the emitter nor its renderer can bind these points to a tool result. A model can invent a list, pass its structural schema, and draw it. The new missing-source negative test fails on that exact behavior before the patch.

CONFIRMED — `server.art` independently calls `sent = broadcast_art(payload)` after recognizing the artifact kind. It does not coordinate with an inline answer or check a source receipt. `response_authoring.agent_result` withholds live answer text for typed authoring, but does not stop that side publication. In addition, the original component ledger limits components, not charts. Both two inline declarations and an inline chart plus a side push are possible. The screenshot alone cannot establish which particular calls produced that turn; the patch closes both paths for new text agent jobs.

CONFIRMED — the source in the old legacy chart schema is optional prose. A sentence claiming Yahoo Finance is not retrieval evidence. The new source credit is derived from a validated source object instead.

UNVERIFIED — the historical values actually returned upstream in the reported turn. Repeated values and a monthly average lower than a current spot quotation do not, by themselves, prove fabrication. The code does prove that fabrication was permitted. As explicitly requested, the new policy refuses identical numeric values across periods; that conservative policy can also refuse a genuinely flat series.

The authoring file, component core/runtime, relevant schemas and helper/publication branches were read. The complete 457 KB server was not read end to end; conclusions are restricted to the inspected paths and tests, not a new audit of every route.

## State and publication model

The text helper owns an `Evidence` object in a ContextVar. It contains this request's original question, clock, network permission, receipt map and publication count. Retrieval creates a random receipt ID with exact typed query, server timestamp, observation-through date, aggregation, missing periods and SHA-256 of the normalized upstream payload. Values and receipts are copied on entry/return. They are not accepted from model prose, a previous turn or another concurrent request. No receipt/session database is added.

Transitions: choose prose or a supported emitter; retrieve if the emitter carries a series; validate complete arguments against the turn receipt; compare every plotted label and unrounded value; emit one completed declaration. Refusal, missing observations or a content mismatch produces words stating the request, the sourcing gap and what is needed. A provider refusal or broken provider response remains a failed turn and logs an ERROR; it is not reclassified as a successful sourcing refusal. Existing cancellation callbacks and generator closure are retained, and the request context is released on exit.

`emit_chart` and the existing chart-bearing `emit_budget` now require a source object. For a budget the source is the user-supplied initial values, and the card identifies the result as a calculation from editable inputs. This is not a claim that a local calculator is an observed historical series. Non-chart comparisons retain their existing table/control contract.

The inline text path publishes at most one chart; the active job also blocks side pushes. This is not yet a strict guarantee for delayed pushes after the job. The existing validator ledger also has a configured one-chart budget. During a text agent job, `/art` refuses unscoped side pushes before changing sequence, last-artifact state or queues. This includes HTML widgets/images because their contents cannot safely be inferred to contain no chart. Clear requests are retained. The existing global agent execution lock already serializes agent jobs; this is a presentation ownership flag, not a new turn lane or lock around execution. Unscoped manual/background pushes during that text job are refused too. There is no client-supplied mode override. Voice-only behavior is unchanged outside a text publication job; no voice helper, file or interface is edited.

Successful chart authoring returns the validated card alone. Model-authored surrounding figures and source prose are not forwarded. A prose-only description of a retrieved series is built from the same receipt, with its source/date. Labeled conflicting figures outside display rounding are rejected. This prevents two independently authored numerical accounts of the same data.

## Retrieval and format selection

The model chooses among the supported fixed emitters and `reply_prose`; it is not forced to use the first regex-matched component. Comparisons, budgets, trends, relative history requests and explicit labeled numeric datasets can enter this choice without naming a chart/card/widget. Coding, exports, conceptual explanations, greetings and simple arithmetic keep their prior path. This is bounded selection among existing components, not a claim that every arbitrary natural-language intent is recognized perfectly or that a new picture generator was added.

For measured history, `retrieve_series` uses a fixed HTTPS Yahoo chart endpoint, daily closes and an exact symbol/date query. It cannot choose a host, arbitrary URL, credentials or follow redirects. USD/UGX requests are checked against `UGX=X`; recognized relative windows are checked against the server clock. A separate provider reads explicit label/value literals in this user request, not numbers extracted from the agent's prose. Web-off prevents network retrieval.

Monthly points are arithmetic means of the available dated daily closes, explicitly labeled observed means. Missing closes/months are omitted and listed, never filled or rounded to a convenient number. A missing month forces bars so the unchanged line renderer does not connect across that gap. These are not current street/bureau quotations, nor a promise of complete coverage of every market day.

`emit_illustration` is a separate, explicitly requested synthetic mode. Its card places “Illustration: synthetic, unmeasured values.” beside its numbers using fixed code; no source or date is attached. It cannot be selected as an unlabeled fallback for missing real data.

The source object is stored in the answer spec. `static/response-core.js` derives a fixed text output from it in both parent and frame. The existing renderer draws that text output; its code is untouched. A query object is retained for audit, while the visible credit is readable source/symbol/date information rather than raw JSON. No visible diagnostics, badges or counters are added.

## Budgets

The canonical manifest keeps the existing byte/node/depth/operation limits and adds `charts: 1`. `response_sources.LIMITS` centralizes: 262,144 upstream bytes, 800 daily observations, 64 plotted points, 2 receipts, 732 history days, 1,024 query characters and a 10-second fetch timeout. Unsupported larger series are refused rather than silently sampled or truncated. Existing authoring argument/provider/context limits remain; the authoring call limit is two so a receipt can be retrieved in one call and referenced by an emitter in the next. Ordinary lightweight replies add no model call. A deep chart job can therefore use two authoring calls after its existing agent execution.

## Instruction and build compatibility

`response_layer.py`, its instruction-generating function and all existing call sites remain unchanged. Adding the source contract expands the schema portion of the same instruction, from 16,524 to 17,434 characters in this export. It is not shortened or replaced. The original hash was `622b9f640d0f3f76b6745a4f6f4425108735532f2f65b4435b5b461f437c2a61`; the expanded instruction is `4ccfbec465fd3fb2284d5f0e0c3147a71c81e1ac5377e9fa7956ba676c969b6e`.

The manifest/runtime fingerprints necessarily change. Existing response checkpoints keyed to the old manifest hash do not automatically restore across that upgrade. No checkpoint migration or storage change is included. Existing saved answers are not rewritten. Old legacy answers and old separately retained artifacts are not retrospectively repaired; the implemented publication guard covers the active helper lifetime. The new delayed-push regression exposes the remaining gap after that lifetime. New-version reload/reconnection behavior remains covered by the existing tests.

`static/v1.js` changes only its builder-generated response-assets comment; all executable painter code is identical. `index_v1.html` changes asset stamps only; every inline script is identical. `build_v1.py`, `index.html`, runtime renderer, parent broker, checkpoint store, styles, voice helpers, approvals, lane/replay/cancel/session logic and atomic writer are checked against the base. Only `front_stream` (helper-local evidence lifetime) and `/art` (text publication refusal) differ among existing server functions. The existing `text_stream` wrapper is unchanged.

## Offline proof

`tests/fixtures/defect6-series.json` is explicitly synthetic test data in Yahoo's dated response shape, with a separate injected server clock. It is not evidence of real FX history and is never selected by production configuration. The fixture is passed through the actual retrieval parser and emitter. The cases change the clock and upstream observation timestamp and check the changed credit through the existing fixed runtime; no model-authored source line is used.

Cases cover source omission; fixture-to-spec identity; retrieval time and observation date; missing months/no line bridging; empty/error/offline retrieval; repeated values; changed points; prior-turn and concurrent-turn receipt isolation; source/query/date/digest tampering; one declaration; conflicting prose beyond rounding; sourced prose; explicit illustration; actual `/art` refusal; model choice without format words; actual fast/deep helper paths; web-off; ordinary/voice delegation; bare/legacy unverified series; URL/redirect refusal; exact protected boundaries; wrong currency/date windows; and provider refusals remaining failed. API responses and agent children in these checks are scripted boundaries, not native model/agent acceptance.

## Files touched

- `response_sources.py`: new turn-owned evidence, bounded retrieval/parsing and consistency policy.
- `response_authoring.py`: mandatory source arguments, adaptive offered functions, retrieval/emission steps, content checks and text-agent presentation lifetime.
- `server.py`: only evidence scope in the existing fast authoring branch and the `/art` publication guard. The old deployed repair regions are retained.
- `response-capabilities.json`: typed source schema and chart budget.
- `static/response-core.js`: source/count validation and deterministic source/illustration text output; no drawing code.
- `static/response-config.js`, `static/v1.js`, `index_v1.html`: generated configuration/fingerprints only; no painter/engine modifications.
- `tests/test_response_authoring.py`, `tests/test_responses.js`: replace unprovenanced positive fixtures with retrieved/synthetic ones; retain existing behavior/security assertions and check the actual three instruction call sites.
- `tests/test_response_server.py`: run the already-fixed builder in a bounded source-only temporary copy; retain deterministic rebuild and identical-engine assertions.
- `tests/test_defect6.py`, `tests/defect6_cases.json`: offline acceptance and actual-helper/route checks.
- `tests/fixtures/defect6-series.json`, `tests/fixtures/defect6-empty.json`, `tests/fixtures/defect6-boundaries.json`: feed/error fixtures and base hashes.
- `verify.py`: one-command runner, including existing regressions.
- `DEFECT6.md`: this delivery record.

## What I could not verify

No real provider or live Yahoo request was made for this proof, and no actual historical USD/UGX rate was established. An upstream outage/schema change or provider tool-call difference can still make a real request refuse readably. A dated upstream payload or a failing case's diagnostics would establish whether the adapter needs adjustment; no credentials or device access are needed.

The original unseen `verify.py`, any private acceptance suite not in eace50e, native phone appearance, and arbitrary side publishers outside this server were not tested. The missing `screen_show` implementation is required to bind the shared side channel to a turn and preserve voice. The scripts expose that fault and prove the other content/data boundaries with controlled fixtures and actual repository helpers; they do not certify every possible model phrasing or the truthfulness of an upstream feed. The checked-in snapshot's redacted identifiers were used as supplied. No production deployment, restart or remote repository write was performed.
