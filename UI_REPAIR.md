# Intelligent UI screenshot repairs

Base: `batte050-design/jarvis-live`, `eace50e404baeffadf87f77a096e7244728217dd`.

This patch repairs the text presentation contract and malformed Markdown tables seen in the six screenshots. It was developed and tested on an isolated checkout. Nothing was deployed, restarted or pushed to the remote repository.

## Findings and changes

- **Table overuse:** `TEXT_MODE_NOTE` required comparisons and sets of figures to use pipe tables, despite the adaptive format guidance elsewhere. Fast and deep text prompts now share guidance that distinguishes simple arithmetic, lists, metrics, steps, entity comparisons and exact matrices. A table remains available when it is useful or requested. This is a model instruction change, not a deterministic guarantee about future model choices.
- **Conflicting component syntax:** one instruction demanded fenced `ui` JSON, another demanded bare JSON. Both text paths now describe fenced legacy display components and keep the existing declared-component schema intact. The deep helper no longer says the screen supports only four shapes.
- **Two publication instructions:** the deep text prompt also demanded `screen_show`/a separate reply widget. Text replies now request inline presentation only. This removes conflicting instructions; it does not enforce ownership of the separate `/art` endpoint.
- **Shifted building columns:** the Markdown painter accepted a four-cell header over five-cell rows. It now supplies `#` only when every body row has exactly one extra leading cell and that cell is the sequence `1..N`. Other inconsistent rows are shown in their original order with their original header, instead of assigning values to incorrect labels. No supplied value is discarded or invented.
- **Literal pipes:** escaped pipes in labels and inline code no longer create extra columns. Odd/even backslash runs and an escaped final pipe are covered.
- **Phone table wrapping:** a later CSS rule forced tables into the card and allowed breaks anywhere in a name. Answer tables now retain readable column widths in their own horizontal scroller, with ordinary word wrapping, unbroken numeric cells, keyboard access and visible scrollbar styling. Full names and units are encouraged in the prompt instead of arbitrary ten-character abbreviations.
- **Unsupported restaurant refusal:** there is no hardcoded venue-directory refusal on the inspected response paths. The new instructions distinguish UI components from research capabilities. Successful restaurant retrieval still needs a real provider/tool test; the screenshot alone does not establish why retrieval failed.

## Verification

Run from the patched checkout, with Python 3 and Node available:

```bash
python3 tools/verify_intelligent_ui.py --report /tmp/jarvis-ui-verification.json
```

All **12 offline suites passed**, including 12 new painter checks, 4 new prompt checks and the existing 40-scenario routing matrix. Existing component state/reconciliation, security boundaries, cancellation/failure handling, warm pre-start and isolated deterministic builds also passed. Provider replies and agent processes in these tests are fixtures; they are not live model or real research acceptance.

The actual generated fast-provider request is checked for the new instructions and one provider call for a simple arithmetic request. All seven screenshot/table-format prompts are checked through the real fast/deep prompt builders. This verifies the instructions delivered, not which format a live model will choose.

Voice system, voice format and deep voice prompt hashes match the exact base. The declared schema prompt is byte-identical. `index.html`, the builder, authoring/response modules, manifest, core/runtime/broker/store and warm-agent code are unchanged. The generated page contains identical inline engine scripts; only asset references change.

Two pre-existing tests described an older tree: one counted two schema-note sites where this base has three, and one expected a hardcoded builder path already removed in this base. They now test the current sites and invoke the actual guarded builder in a temporary copy. No production behavior was changed to satisfy those assertions.

**Visual acceptance is unverified.** No Chromium executable was installed in this environment. The attempted Playwright browser download failed with a truncated/non-ZIP download. The supplied screenshots were inspected, but the patched CSS was not rendered on a real phone/browser. Check widths around 320–430 px in staging, swipe a five-column table to its last column, and check the long building names before approving deployment.

## Apply to a disposable copy

The delivery includes `intelligent-ui.patch`, based on the exact commit above. It includes the source, generated page, regression tests and this note.

```bash
git apply --check /absolute/path/intelligent-ui.patch
git apply /absolute/path/intelligent-ui.patch
python3 tools/verify_intelligent_ui.py --report /tmp/jarvis-ui-verification.json
```

If rebuilding locally, the builder requires the absolute directory containing itself:

```bash
python3 build_v1.py --target "$PWD"
```

To reverse this exact patch in that same copy, after preserving any later work:

```bash
git apply --reverse --check /absolute/path/intelligent-ui.patch
git apply --reverse /absolute/path/intelligent-ui.patch
```

These are patch/application instructions, not a production deployment procedure.

## Separate earlier chart candidate

The earlier `jarvis-defect6-eace50e-candidate.zip` was inspected and **not applied**. Its own proof reports a failing delayed unscoped `/art` publication case and requires the missing `screen_show` publisher implementation to preserve voice while binding that channel to a turn. This repair does not claim to solve that separate sourced-chart/publication boundary, verify historical FX observations, or retrofit old saved answers. Source instructions here are guidance, not receipt-based provenance enforcement.
