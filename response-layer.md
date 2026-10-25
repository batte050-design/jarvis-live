# Declarative text responses

This implements the response layer against c49e542. It assumes the eighteen stated production repairs are already present on the deployment. It neither includes nor reimplements those repairs. The inline transport engine is unchanged.

## Files and authority

`response-capabilities.json` is the only capability allowlist. It contains schemas, templates, operations, action classes, endpoint declarations, appearance bounds and budgets. `static/response-core.js` interprets that data in the parent and frame. `response_layer.py` stamps the manifest/runtime and produces the fixed frame document. `static/response-runtime.js` and its stylesheet are repository-owned code, inlined under exact CSP hashes on the existing widget hostname. No model HTML, scripts, handlers or styles are accepted.

The builder produces `static/response-config.js` and links the core, checkpoint store and parent broker before `v1.js`. Its response-assets marker in `v1.js` changes that file's own content hash whenever the response asset bundle changes, so existing `/build` detection still works without an interface change.

## Contract

Only complete `ui` fences activate new widgets. Root fields: `type: "widget"`, `version: 1`, unique answer-local `id`, `component`, optional `props`, optional `initial`, optional declared `actions`, and required readable `fallback`. Application components additionally declare `inputs`, a forward-only typed `graph`, and `outputs`. Template components cannot override their input/graph/output declarations. Unknown fields and unknown references reject the whole specification to its readable fallback, or fixed readable words, before the old heuristic fallback. The payload itself is never the rejection text.

```ui
{"type":"widget","version":1,"id":"quote","component":"quote-estimator","props":{"title":"Quote","currency":"UGX"},"initial":{"quantity":10,"price":10000,"discount":1000},"actions":[{"id":"discuss","class":"AGENT","label":"Discuss this quote","question":"Help me review this quote."}],"fallback":"Ten units at UGX 10,000 with a 10% discount: UGX 90,000 total."}
```

Monetary state is in integer currency minor units. Money fields display major units according to the chosen currency; UGX has no fractional minor-unit conversion. Quote discounts are integer basis points: 1000 means 10%. The discount is rounded to a minor unit before subtraction. Bill tips are rounded before allocation; the splitter shows groups paying the base amount and one additional minor unit so allocations sum exactly to the total.

Template inputs:

| Component | Input IDs |
| --- | --- |
| quote-estimator | quantity, price, discount |
| bill-splitter | bill, people, tip |
| budget-planner | income, housing, food, other |

Custom components `application`, `table`, `chart`, `map`, `quiz`, `diagram` use the schemas in the manifest. The named output components require their corresponding output. Controls include range, stepper, toggle, text, number, date and select. Bindings are literals or `{ "ref": "declared-id" }`. Every calculation references only inputs or earlier calculations. `dateDiff` uses UTC date-only values. There is no expression evaluation or arbitrary property lookup.

Tables use declared columns and rectangular rows. Charts support positive/negative bar and line values with readable value lists. Maps use an equirectangular coordinate grid with labels and optional action hotspots; they do not load a basemap. Quizzes bind to a declared select input and provide local feedback. SVG diagrams accept bounded rect, circle, line, polyline and text primitives. Native 44px hotspot buttons overlay fixed SVG geometry. A hotspot names exactly one declared action.

Legacy shapes (`type` present, no `component`) go directly to the existing renderer. No legacy adapters are shipped, and the response layer does not validate or reinterpret legacy choices. The legacy schemas retained by the core's standalone validation API are not production admission gates. Only complete declared component fences enter the new layer; ordinary prose, file markers, tables and code fences retain the existing painter.

## Action classes

- LOCAL changes a declared input inside the frame. Only bounded input checkpoints cross to the parent for persistence; no network or turn action is implied.
- DATA resolves an endpoint ID through the manifest, never a frame-supplied URL. The broker uses same-origin GET, credentials omitted, redirects rejected, JSON/schema/byte limits, deadlines, revision checks and aborts. The shipped allowlist is empty. No data-source service is installed.
- AGENT can only nominate a declared action for review. The parent renders the question and validated snapshot as text. Its own fixed-label Send to JARVIS button requires a trusted primary pointer-down and matching trusted click, with a single-use two-second token bound to action, component, input revision, frame generation and conversation. Tokens never enter frames or storage. Token validity is checked when the click consumes it; the subsequent bounded preference refresh does not require an already-consumed token to remain unexpired. The final call is the existing `ask(question, 'text')`. Busy turns, stale state and changed policy deny it; authorization and risky-action approval remain on the existing turn path. Keyboard users can edit the staged question in the ordinary composer and send it there.

The parent cannot attest to pointer events inside an opaque frame. Consequently AGENT hotspots always require a second parent-owned review gesture. Frame messages never submit a turn. New frames are not registered with the legacy widget message handler.

## State and failure model

| State | Owner/storage | Transitions and invariants | Failure |
| --- | --- | --- | --- |
| Manifest and fixed assets | Repository/build; SHA-256 stamps | Parent/server/frame versions must agree | Literal fallback, no mount |
| Block identity and DOM | Existing text painter plus response registry | Existing conversation and turn identity, component order, manifest and spec hash; declared islands retain connected iframe nodes as the original painter stages the rest of the answer | Changed declarations dispose replaced instances; no second stream reader |
| Immediate inputs | Opaque frame memory | Valid inputs update immediately; temporary incomplete edits do not commit or nominate AGENT actions | Invalid declarations become text; runtime failure reveals parent fallback |
| Checkpoints | Parent IndexedDB, a new response-only database | Account, session namespace, installation, conversation, turn and specification scoped; 30-day inactivity expiry; bounded globally; ACK only after commit | No false durable ACK; readable current values on storage failure |
| Checkpoint delivery | Frame and parent registry | One in flight, coalesced later changes, bounded retries of the same revision; duplicate ACK recovery cannot rewrite state | Deadline degrades to readable fallback |
| DATA | Parent requests and frame revision | Allowlist plus settings; stale results dropped; no automatic fetch on restore | Retain prior state; log failure |
| Review/token | Parent memory only | Current acknowledged state, active chat, current policy and pointer gesture; single use | Drop without touching the answer lane |
| Preferences | Existing chat_settings.json, namespaced response object | Existing settings lock; preserve web/memory and other fields; owner guard plus same-origin write | Invalid/corrupt values deny rather than overwrite unrelated settings |

The journal contains input state only, not auth cookies, turn records, answers or approval state. Normal reload/reconnect restores the last acknowledged checkpoint in the same browser/session/build. In-progress previews that were not acknowledged are not guaranteed after abrupt reload. Specification or manifest changes deliberately do not migrate old state implicitly. Cross-device state sync is not provided.

Deletion/purge checks read the existing UI tombstones and purge stamp; only response records are removed. Sign-out disposes response instances and clears their checkpoint namespace; an additional non-credential session namespace prevents a later login from reading an interrupted cleanup. Queued writes recheck current policy before storing. No session/history store is written by this layer.

The parent accepts messages only from its registered frame window, opaque `null` origin, current nonce and strict payload schema, under frame/page quotas. A `null` origin alone grants nothing. The frame checks the exact parent origin, parent window, nonce and schema. Readiness and mounted acknowledgements keep the readable fallback visible until content exists. Runtime/model text is always assigned through textContent/text nodes. Readable rejections and component reviews are excluded from file-marker rewriting.

The numerical budgets are all in the manifest. Schema ceilings also live there. Budget failures are atomic per component. Replayed blocks are not charged twice. The original full-answer painter owns its table/source suppression bag on each paint; the broker does not parse or fold ordinary blocks.

## Appearance and preferences

The frame follows the existing widget kit's dark/light palette, flat surfaces, thin rules, system sans typography and 44px controls. It follows the page's theme and text scale through validated messages, without reloading the frame. Controls collapse to one column on narrow screens; tables scroll within their own region; metrics wrap. Existing frame-height clamping and internal scrolling keep long content reachable. No diagnostics, counters, timing badges or readouts are added to the UI.

Quick Tools contains a text-only "Responses in this chat" group: interactive responses, reviewed questions, declared data requests, and remembered inputs. Reviewed questions/data default off. The DATA switch is disabled while no endpoints exist. Disabling remembering removes response checkpoints for that chat. Turning interactivity off disposes its frames; turning it back on remounts them with fresh nonces and the current values. Existing web/memory preferences and their endpoints remain unchanged.

## Tests and build

From the repository root:

```
node tests/test_responses.js
node tests/test_response_repairs.js
python tests/test_response_server.py
```

Independent component checks:

```
node tests/test_responses.js --group components --component quote-estimator
node tests/test_responses.js --group components --component bill-splitter
node tests/test_responses.js --group components --component budget-planner
node tests/test_responses.js --group components --component table
node tests/test_responses.js --group components --component chart
node tests/test_responses.js --group components --component map
node tests/test_responses.js --group components --component quiz
node tests/test_responses.js --group components --component diagram
```

The Python builder check copies the application into a disposable directory and binds only the pinned builder's hardcoded HERE in memory. It runs the actual builder twice, checks deterministic output, all stamps and identical inline engine bytes. It never writes /data/apps/jarvis-live. On a baseline-layout application target, the normal rebuild is `python /data/apps/jarvis-live/build_v1.py`; do not run the pinned builder expecting an arbitrary checkout to be its target. If deployment already has its own builder target guard, retain and use that guard. No builder-isolation repair is included.

Tests use standard Python/Node libraries, DOM doubles and actual extracted route/helper code; they do not import or run the production service. They test the actual frame bootstrap in a VM, but cannot prove native browser origin isolation, native trusted-event generation or IndexedDB durability. The generated index_v1.html is included in the activation patch. Existing stylesheet/approval-script URL stamps are recomputed from the pinned source bytes; those files are unchanged.

## What is not verified or not included

No production browser session, native Android device, native CSP/opaque-origin/IndexedDB run, full FastAPI service, real provider turn or latency measurement was available. The exact deployed eighteen-fix source tree was not available. A reconstruction from the earlier reference patches is a compatibility check, not proof about deployment.

Deliberately absent: nonempty DATA endpoints, network basemaps/geocoding, cross-device checkpoint synchronization, automatic state migrations across changed manifests/specifications, arbitrary HTML/SVG/code, additional model calls, and voice work. None of the requested component families is deferred. The eighteen deployed fixes, session storage, transport, turn lanes, replay and approval logic are not changed.


## Native live proof for the rendering repair

Detached `__jarvisDraw` previews intentionally stay readable and do not constitute a mount test. Use a real authenticated chat with interactive responses enabled. Turn IDs are opaque nonempty values: the application's own `turnTid` fallback is 16 hex characters. Conversation IDs still satisfy the existing server route's 32-hex requirement. A connected component waits up to the existing frame-ready budget for the conversation hook and turn element to become available; it never creates a conversation or submits a turn to obtain identity.

Run the repository-owned `tests/response_live_probe.js` as a DevTools Snippet **before** submitting a normal text question. The probe is never loaded by the production page. It creates no elements, identities or turns and does not replace any transport hook. It logs only proof booleans and asset hashes. It must observe a visible native sandbox frame in `#thread .turn .t-a`, a valid opaque-origin input-change message and ACK, followed by growth of ordinary answer text while the **same** server turn is still alive and the **same** frame remains connected. A timeout or a finished turn produces INCOMPLETE, never PASS. Move an input immediately when the estimator appears. Capture a screenshot showing the live conversation with the component and later text; retain the console report separately.

A suitable single-call prompt is:

> Start with this exact fenced ui block, then continue with a long plain-language explanation of the quote, at least 700 words. Do not call tools, do not repeat the JSON, and do not put the explanation in another fence.
>
> ```ui
> {"type":"widget","version":1,"id":"live-quote","component":"quote-estimator","fallback":"Estimate the cost from quantity, price and discount."}
> ```

If the model completes before the operator changes an input, this does not prove concurrency: repeat the acceptance run or deliberately throttle the browser's connection, without changing the application. The probe makes no claim about its results until it has actually run in a native browser. It cannot establish native AGENT gesture behavior, native IndexedDB persistence, the operator's private 29-case corpus, or the exact deployed contract/layout acceptance results.
