# Jarvis text presentation with OpenUI Lang 1.0

Based on `thesysdev/open-intelligent-ui` at `03213439358bf3408ad61a46ec9e3230c5572e48` (MIT). The real `@openuidev/lang-core` and `@openuidev/react-lang` 1.0.0 parser/runtime are bundled locally, with the reference React components and 60 functions (including the Jarvis receipt lookup). This replaces the previous text intent-classifier/canned-emitter route, not the agent's tools or approvals.

`response_openui.py` offers the same general presentation prompt on every text question. The model chooses ordinary prose or a fenced `openui` program. Fast answers use the existing front model once; tool-using answers first obtain findings through the existing agent, then use that same general presenter. No UI keyword classifier or required emitter tool selects a layout. The existing agent-routing classifier still decides whether real work/tools are needed; it does not choose a UI.

The opaque sandbox frame uses the upstream Renderer, $bindings, arithmetic and functions. It receives progressive program updates without replacing the React root or iframe. Local edits do not send a model turn. @ToAssistant prepares a composer draft; sending still belongs to the user. Query, Mutation and arbitrary HTML/JS are not exposed. SDK runtime telemetry is removed at build time and installation scripts are disabled. No CDN, hosted OpenUI service, or new paid provider is required.

Images are real Wikimedia photographs with author, license and retrieval date. Image/src also resolves the subject through this credited search rather than fetching an arbitrary model URL. Both upload.wikimedia.org and thumb.wikimedia.org are supported; tracking query parameters are removed. Image failures retain readable text and mark a partial result. Photo query results are cached in process memory for one hour. Web Off prevents new photo lookup. New frames require the current response preference; signing out closes them.

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

It requires `DEEPSEEK_API_KEY` in the environment. This gate was NOT run in this checkout because no provider key is available. The temporary live review cookie is not a model API key and was not used as one. The browser proof uses scripted model programs; a separate read-only Wikimedia check fetched real photos and their metadata. Passing those tests does not establish model-generated layout quality or word-for-word correspondence with a different model in the hosted demo.

Voice remains paused; its original wrapper/publication grants and four prompt hashes are preserved. No deployment or push was performed. Two existing plugin tests are explicitly skipped because plugins/screen is absent from exact base 8c2e433. STT/TTS, unexplained service restarts and intermittent empty tool-agent turns are not established by these tests. OpenUI edits survive streaming/settlement but are not currently checkpointed across reload or conversation reconstruction; the legacy widget checkpoint system is unchanged.
