# Harness page channel — revision 2

Review base: `285f9dd`, `review/page-presentation`. Harness patch base: the supplied working-tree copies at installed revision `f0d0955aa2`, not that revision's git HEAD. Application patch base: the supplied R6 `page/server.py` snapshot and the saved R6 `index.html`. Staging handoff asset stamps were JS `159e5556db`, CSS `ed362e86f3`.

Nothing installed, deployed or restarted by this revision. The running page remains unchanged until the owner applies these patches. No real-model proof, new thirty-question batch or latency/parity claim is included.

## The two failed fixture cases

Reproduced both failures from the delivered ZIP. The child failed in `subprocess.Popen` with `PermissionError(13)` because archive extraction did not preserve the Python fixture's execute permission. It never reached ACP and never invoked the installed harness. The tests now launch the fixture through `sys.executable` explicitly. They run with the file mode left at 0644. This corrects the earlier package portability failure; it is not a claim about a real-model turn.

## Implemented source changes

- The original durable coordinator and primitive fixes are included cumulatively, now module version **1.2.0**. Version changes create a separate session mapping. No active session's profile is rewritten.
- `page/installed_hooks.py`: real session/new and session/load requests; server-produced owner/conversation/session/version/prefix/tool attestations; exact pending-action permission binding. Real load responses contain no sessionId, so the requested ID is verified against the server metadata rather than invented from a client-side receipt.
- `harness/acp_adapter/page_presentation.py`: a per-agent frozen wrapper around the installed `_build_system_prompt` method. It retains the harness-generated persona, policy and tools, adds the versioned page module once, persists the exact complete prefix privately, restores those exact bytes after restart, and refuses binding/tool-schema drift. Current UTC is supplied after the prefix as a trailing prompt block.
- Supplied SessionManager source: page profiles persist even before the first user turn, so a prewarmed session is loadable after restart. Non-page empty probes keep their previous behavior. Page restore requires its saved profile binding and frozen prefix.
- Supplied ACP server source: attestation is emitted through standard `_meta` fields after persistence is confirmed. Late MCP refresh and model changes cannot mutate a frozen page profile. The normal terminal/edit approval transport is retained, with the exact pending tool arguments attached privately. A real tool-call ID resolves multiple pending calls; a synthetic ambiguous request is refused rather than guessed.
- Completion is separately attested. This server previously returned `end_turn` after an executor error. Page mode now requires a matching successful completion and accepted payload hash before the coordinator can publish. Accepted-then-failed, interrupted or cancelled turns cannot release a card.
- `page/bootstrap.py`: constructs the actual ACP driver with those hooks. No provider client or bare-model fallback exists here. The driver retains at most two resident children; idle children may be closed and their isolated durable sessions loaded later.
- `page/legacy.py` and the application server patch: text `/stream` routes exclusively to the harness coordinator before legacy prewarming or front-model work. The old text branch in `front_stream` is removed. Window creation/startup no longer starts an unused legacy agent; text prewarming is owned by the named page conversation. Page cancellation/reattach use explicit page handles. Startup failures produce one readable failure envelope and a privately logged error ID. Existing page-owned model-based conversation naming is skipped for harness-owned conversations. Durable completed turns overlay the existing page history by turn ID, including turns completed while disconnected.
- The application `index.html` patch consumes terminal presentation envelopes through the existing renderer, carries trusted receipts into its existing OpenUI format, replaces the answer for the existing turn, displays enum progress ephemerally, and presents approve-once/deny controls. It does not append a second answer or expose tool arguments/logs. Text composer focus/input requests named prewarming; it sends no user question or model generation request.

## Apply on isolated staging only

1. Verify the exact source preimages. `review.patch` applies to the review checkout at 285f9dd and is the complete review diff. It is not an instruction to deploy that old checkout's root application files.
2. Apply `harness.patch` from the root of the installed harness, with `git apply --check` first. It changes only `acp_adapter/session.py`, `acp_adapter/server.py` and the new `acp_adapter/page_presentation.py`. Apply onto the supplied dirty working-tree bytes, preserving unrelated local modifications.
3. Copy the runtime `files/page/` package into the R6 application as `page/`, excluding the review snapshots `page/server.py` and `page/index.html`, tests and evidence. Install the updated `page/plugin/` as the existing `page_presentation` plugin through the harness's existing registration/configuration. Ensure the toolset is available; prewarm fails explicitly if emit_ui/emit_progress are absent. Do not load a second old plugin copy alongside it.
4. Apply `application.patch` from the R6 application directory, after `git apply --check`. It changes only `server.py` and `index.html`. Never overwrite private server.py wholesale. The operator identity lines are outside these hunks.
5. Keep `JARVIS_OPENUI_NODE`, `JARVIS_LOOKUP_PYTHON`, the staging engine home and paused voice configuration. `PRESENT_STORE`, if set, is honored; otherwise state is under `ctx/page-presentation`. Build only staging with `python3 build_v1.py --target "$PWD"` from its absolute application directory. The renderer assets and CSS are unchanged; the rebuilt HTML changes because its embedded event handler changes.
6. Owner controls the staging process restart and live publishing. Verify /build and the page's HTML stamp. No live commands are part of this package.

## Verification and limits

Use the installed harness interpreter or a disposable test environment with the app's FastAPI stack, httpx and agent-client-protocol. The schema serialization check here used SDK 0.12.1; run these same tests with the installed SDK as well.

    PRESENT_TEST_APP=/absolute/path/to/r6 python3 -m unittest discover -s page/tests -p 'test_*.py' -v
    node page/tests/test_client.js
    node page/tests/test_event_browser.js /absolute/path/to/chromium

Source tests execute the supplied SessionManager and patched server methods with controlled fixture agents/DBs. ACP child tests use Python explicitly and do not require executable archive modes. Chromium event checks cover 320/390/430 px. The existing native renderer suite was also run against the rebuilt candidate HTML. These are offline checks, not the requested live harness proofs.

After owner application: cold identity, one real tool-backed adjustable card, interleaved A/B phrase isolation across adapter restart, and actual provider-origin recording must pass before the thirty-question/repeat gate. The local failure test forbids page urllib provider calls, but it does not substitute for observing the installed processes' traffic. Required-shape/recompute repeat checks and the three latency clocks remain acceptance gates. No 99 percent claim is made.
