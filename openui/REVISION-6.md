# R6 — staging candidate, not a parity approval

Base: delivered R5 (JS a074aacacc, CSS ed362e86f3, runtime ce405d7754fb79320ef2570b1bb274526384526d547c79afc46bba29853e7d0e).
Apply revision-6-only.patch on R5 staging with git apply --check before git apply. Preserve private identity lines in server.py. Never copy the public server.py over the private running copy. Live remains untouched.

## Fixes

* Calculation probes select controls inside the frame by reactive state target, not label words. Each primitive formula dependency needs a visible enabled bound input. The probe changes it, checks the value actually entered, observes output change and restores it. A test-only reader supports the installed R5 React bindings; R6 emits explicit data-state-binding attributes. Accessibility labels remain intact. Arbitrary labels A/B/C are tested.
* Wikimedia can return HTTP 200 with zero licensed candidates for expanded queries ending in presentation modifiers. The broker retries once without those suffixes, preserving the subject, attribution, URL allowlist and license checks. It records both queries and candidate counts. It never truncates arbitrary entity names. A stalled image download gets a bounded timeout and moves to its next credited candidate.
* The reported form fetch failure was POST /timeline, blocked by the harness. The logger used a synchronous try/catch around an asynchronous fetch. R6 catches its rejection and the harness permits that staging logging POST. Text focus no longer prewarms an unrelated task agent. Form draft capture waits until the frame message has actually arrived.
* Grouped number fields no longer rewrite their value on focus. Probes verify the entered/restored amount instead of accepting any changed output. The quote regression checks 80,000 -> 100,000 -> 80,000 and 288,000 -> 360,000 -> 288,000.
* Read-only calculated $state defaults are lowered to ordinary expression aliases before validation/rendering. The pinned SDK stores those defaults as AST objects rather than calculating them. Mutable defaults and control/action targets keep their original names; computed editable defaults are rejected for repair. Strings, comments, object keys and name collisions are preserved. The recovered fuel answer is a real regression fixture.
* A frame acknowledges mounting only after real content exists. Empty renders and top-level renderer crashes emit diagnostics rather than a blank success.
* Textual DSML tool-control output is refused outside code fences and retried within the existing provider-call budget using the structured tool API. Printed commands are never executed. Non-thinking text generation uses temperature 0; thinking mode retains its supported settings and avoids unsupported forced tool choices. This reduces variation; it does not prove parity. Official provider behavior: https://api-docs.deepseek.com/api/create-chat-completion/ and https://api-docs.deepseek.com/guides/thinking_mode/.

The exact public protected-boundary postimages change only for the reviewed image endpoint, async timeline handling, and text preparation change. The private accounts identity pin is not waived.

## Evidence limits

The workspace reverted to R3 between turns. Original R6 browser reports/screenshots were lost. The saved R5 delivery was restored and R6 rebuilt from the recorded findings. Staging history recovered real answers for all 30 frozen questions and repeated answers for many cases, plus three clarification follow-up transcripts. Those history records do not retain the original SSE verdicts; their status is explicitly unknown. They are not presented as a recovered single browser batch.

Additional fresh-model repeat-completion calls were rejected by automatic approval review, citing an earlier handful-of-turns limit and model cost. No workaround or indirect fresh model execution was used. repeat-stability.json therefore remains INCOMPLETE, never green. Candidate replays and local fixture tests must not be mistaken for a fresh installed-build acceptance run.

## Required after owner application to staging

Keep JARVIS_OPENUI_NODE and JARVIS_LOOKUP_PYTHON configured in the service. Check /build and authenticated /api/openui/health.

    python3 tools/verify_intelligent_ui.py --browser "$CHROMIUM" --report "$EVIDENCE_DIR/r6-suites.json"
    node tools/staging_generative_browser.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r6-browser30" --allow-cancel
    python3 tools/generative_probe.py --replay "$EVIDENCE_DIR/r6-browser30/browser.json" --report "$EVIDENCE_DIR/r6-browser30/answers.json"
    node tools/repeat_stability.js --run --cookie-file "$REVIEW_COOKIE_FILE" --browser "$CHROMIUM" --report-dir "$EVIDENCE_DIR/r6-repeat" --allow-cancel

Thirty questions plus two further passes of 21 composed cases require 72 model turns, with three clarification follow-ups bringing a full combined gate to 75. Running the two commands independently above repeats more work; prefer the combined repeat gate, which uses its first full 30-question pass as repetition one before two composed-only passes. It stops on a failed pass by default; --continue-on-failure requests all repetitions even after failures. Real-model execution requires approval review to permit that explicit budget. Reference side-by-side review at 320/390/430 remains required; no 99 percent claim is made.
