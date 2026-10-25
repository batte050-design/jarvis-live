# Jarvis text presentation with OpenUI Lang 1.0

Current staging revision: see `REVISION-3.md` for the service Node validator/preflight, required interactions, complete diagnostics and mounted browser gate. Earlier revision notes are retained as history.

Based on `thesysdev/open-intelligent-ui` at `03213439358bf3408ad61a46ec9e3230c5572e48` (MIT). The real `@openuidev/lang-core` and `@openuidev/react-lang` 1.0.0 parser/runtime are bundled locally, with the reference React components and 60 functions (including the Jarvis receipt lookup). This replaces the previous text intent-classifier/canned-emitter route, not the agent's tools or approvals.

`response_openui.py` offers the same general presentation prompt and composition examples on every text question. The model chooses ordinary prose, a clarifying form, or a fenced `openui` program. Public reads use a bounded bridge to the existing engine's search/extract functions. Text bypasses the old work-keyword router. Only an explicit model `request_task` call delegates private/stateful work or an explicitly requested file to the existing guarded agent. No new paid service or provider credential is introduced. See `TAKEOVER.md` for the exact-base repair and staging gates.

The opaque sandbox frame uses the upstream Renderer, $bindings, arithmetic and functions. It receives progressive updates without replacing the iframe. Two bounded grammar repairs use an authoritative replacement, and server-owned receipts remain attached throughout. A corrected frame can recover after a failure while retaining edited state. Local edits do not send a model turn. @ToAssistant prepares a composer draft; sending still belongs to the user. Query, Mutation and arbitrary HTML/JS are not exposed. SDK runtime telemetry is removed at build time and installation scripts are disabled.

Images are Wikimedia photographs with author, license and retrieval date. Image/src resolves the subject through credited search rather than fetching a model URL. Both upload.wikimedia.org and thumb.wikimedia.org are supported. Requests queue, with three in flight and twelve per frame. Pending image loads keep the turn FINISHING; failed media marks it PARTIAL. A completed lookup alone is not a loaded image. Web Off prevents new photo lookup. New frames require the current response preference; signing out closes them.

Historical/supplied chart rows come from the existing turn-owned response_sources receipts. The model receives an id and uses @Receipt(id); invented rows, altered ids and appending fabricated rows are rejected. Receipt metadata is inserted by the server, not accepted from the model. Native prose/table fact handling otherwise remains the existing assistant/tool behavior.

52 components are advertised: layouts, text, controls, Image/SearchImage/Icon, Table/Chart, Math, SVG primitives, Flashcard and Celebration. Accordion is a small local addition. Maps, YouTube, arbitrary HtmlView, hosted tools and the reference Next/PostHog shell are not included. Icons use a fixed local subset with an information icon fallback. The reference layout/text/controls/extra/chart/table/SVG/function sources and licenses are retained under src/reference and licenses. Adaptations: local icon lookup, credited image broker, Accordion, receipts, minimum control sizes, theme tokens, and stream/failure/host boundaries.

The native painter's unexpected header sorting was removed at the user's explicit request. Header taps/key activation preserve all original rows and values. Other native prose, code, lists and table content/layout are retained; only the table sorting affordances are removed. Entry guards recognize OpenUI fences before the native painter. The old component contract and stored typed widgets remain supported.

## Build and review

The generated renderer, CSS, standalone Node validator and prompt are checked in. Deployment needs no npm install. Building from source was tested with Node 24.22.1:

```sh
npm ci --prefix openui --ignore-scripts
npm run --prefix openui build
python3 build_v1.py --target "$PWD"
python3 tools/verify_intelligent_ui.py --browser /absolute/path/to/chromium --report /tmp/jarvis-openui.json
```

The outer builder includes both runtime assets in the page build stamp and emits `static/openui-config.js`. Frames use a content-versioned URL, and the server rejects a mismatched version, preventing a refreshed page from silently using an old cached renderer.

The optional real-provider gate performs exactly three fresh questions using the existing provider, reads its key only from the process environment, and never touches the live app, configuration or history:

```sh
python3 tools/acceptance_openui_model.py --run --model deepseek-v4-flash --report /tmp/openui-model.json
```

That optional direct-provider tool requires `DEEPSEEK_API_KEY`; it was not run here. The staging-only runners in `TAKEOVER.md` use the existing server model through `/stream` and need no model key on the reviewer's machine. Local browser proof uses scripted programs and photo bytes. It does not establish model-generated layout quality or word-for-word correspondence with a different model in the hosted demo.

Voice remains paused; its original wrapper/publication grants and prompt hashes are preserved (private-persona assertions require the operator's excluded persona). No deployment was performed. Two plugin tests are skipped because `plugins/screen` is absent from exact base c035fc9. STT/TTS, unexplained service restarts and intermittent empty tool-agent turns remain separate unproven issues. OpenUI edits survive streaming/settlement and repair but are not checkpointed across reload or conversation reconstruction; the legacy widget checkpoint system is unchanged.
