# Acceptance target: 99 percent measured reference parity

This target is NOT met by this revision's local tests. Do not deploy on those counters.

Minimum release gates: all 30 frozen questions obey the shape contract in tests/fixtures/parity-contract.json; each composed question passes three real independent runs with the same mounted shape signature; quote, bill, fuel, buy/rent, budget, Ohm law and picnic recomputation probes pass without another model turn. Greetings, explanations, code and explicit tables stay prose. No blank frame, no unexplained partial. Any failed case blocks acceptance.

The under-specified day-out case must give a brief question and five relevant fields. Its browser probe fills all five, verifies every answer enters the draft, explicitly sends the next text turn, and saves clarifying-form-transcript.json. It adds one follow-up turn beyond the 30 initial questions. A local fixture test is not real-model proof.

Both reference and staging must be reviewed side by side at 320, 390 and 430 px. Capture the reference version/build or a dated identity if it has no stamp; capture staging /build and /api/openui/health. Contrast audit runs INSIDE the frame: text >=4.5:1 and controls/icons >=3:1, with composited background colors. Screenshots override a green counter when they contradict it. Scroll/header overlap, typography and spacing still require visual review. The repeat signature permits different wording but rejects different counts/types of controls, photos, charts, forms or buttons.

Deliver browser.json, answers.answers.md, all three-width screenshots, both application identities, repeat-stability.json and clarifying-form-transcript.json. A 30/30 pass is a finite acceptance sample, not statistical proof of a 99 percent success probability. Human reference review remains a separate required gate. No aggregate percentage can hide a failed mandatory case.

## Changes under review

Restores r4 from the delivered archive, then adds strict test-side answer-shape expectations, independent repeat runner, five-field clarification/follow-up evidence, more calculation probes, grouped numeric input display with currency indicators, ticks/readout near the slider, higher-contrast tokens, card padding, opaque app-bar masking, calculation credits without ISO timestamps and the same read-only hosting-server telemetry source used by the home screen. Server snapshot is labeled hosting server, never user's phone/laptop. Failed telemetry is reported unavailable. No identity configuration is exposed.

Prompt changes discourage numeric duplication between prose and cards. This is not yet proven consistent with the real provider. No deterministic prompt-specific runtime router was added. The original frozen questions are unchanged.

## Staging-only execution after applying this patch

Keep existing JARVIS_OPENUI_NODE and JARVIS_LOOKUP_PYTHON service configuration.

    python3 tools/verify_intelligent_ui.py --browser "$CHROMIUM" --report "$EVIDENCE_DIR/r5-local.json"
    node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r5-browser30" --allow-cancel
    python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/r5-browser30/browser.json" --report "$EVIDENCE_DIR/r5-browser30/answers.json"
    node tools/repeat_stability.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r5-repeat" --allow-cancel

These commands spend real model turns. The repeat runner stops on incomplete turns. It is acceptable for new gates to expose failures; fix those failures rather than weakening the assertions. Staging's fixed /api/dev/run commands run the installed files only and cannot install this patch or run arbitrary new commands. The owner must apply this revision before those remote gates can measure it. Live publishing remains the owner's decision.

The protected-boundary postimages are updated for the intentional front_stream snapshot change and CSS, without relaxing the private accounts identity pin. No deploy performed.
