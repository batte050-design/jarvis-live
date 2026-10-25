# Path map — where each part of the presentation system lives

Deployed root: `/data/apps/jarvis-live` (live worktree, deliberately dirty).
Installed plugin root: `/home/ubuntu/.hermes/plugins/page_presentation`.

| Concern | Deployed path | Snapshot path |
|---|---|---|
| HTTP app, routes, auth, page assembly | server.py | app/server.py |
| Instructions JARVIS receives (answer-side prose/prompt blocks) | response_openui.py | app/response_openui.py |
| Per-turn prompt injection (question + UTC + `<page_render_capabilities>`) | page/driver.py:97-99 | app/page/driver.py |
| Instruction contract for the presentation plugin | plugin prompt.txt | plugin/prompt.txt |
| `emit_ui` / `emit_progress` tool schemas, acceptance, refusal rules | plugin __init__.py | plugin/__init__.py |
| Emission receipts (private diagnostic files) | plugin __init__.py:64-120 | plugin/__init__.py |
| Accepted-payload store, atomic create-if-absent | plugin store.py | plugin/store.py |
| Approval record for the page lane | plugin approvals.py | plugin/approvals.py |
| Progress channel | plugin progress.py | plugin/progress.py |
| Cross-process locks | plugin locks.py | plugin/locks.py |
| Component catalogue + validation (authoritative) | openui/validate.cjs | app/openui/validate.cjs |
| Validation rules, harness-vs-legacy gates, image rules | openui/src/guard.ts | app/openui/src/guard.ts |
| Component definitions (library) | openui/src/library.tsx | app/openui/src/library.tsx |
| Runtime frame document | openui/src/frame.tsx | app/openui/src/frame.tsx |
| Validator CLI wrapper | openui/src/validate-cli.ts | app/openui/src/validate-cli.ts |
| Positional-repair helper (spawned per validation) | plugin openui_validate_once.py | plugin/openui_validate_once.py |
| Renderer — parent page | static/openui-parent.js | app/static/openui-parent.js |
| Renderer — iframe runtime | static/openui-frame.js | app/static/openui-frame.js |
| Renderer — page app | static/v1.js | app/static/v1.js |
| Renderer CSS | static/openui-frame.css, static/v1.css | app/static/ |
| Page markup | index_v1.html, index.html | app/ |
| Build scripts | build_v1.py, openui/build.mjs | app/ |
| Citation/source handling | response_sources.py, response_lookup.py | app/ |
| Image sourcing (server side) | response_images.py | app/response_images.py |
| Typed authoring emitters (legacy lane) | response_authoring.py | app/response_authoring.py |
| Response layer hooks | response_layer.py | app/response_layer.py |
| History projection into the page | page/legacy.py | app/page/legacy.py |
| Turn record + step ledger | page/adapter.py | app/page/adapter.py |
| Warm child lifecycle | page/warm_agent.py, warm_agent.py | app/ |
| Recovery before page work | page/recovery.py | app/page/recovery.py |
| Runtime document route | server.py:9391 `/api/openui/runtime` | app/server.py |
| Image broker route | server.py:9404 `/api/openui/images` | app/server.py |
| Form submission path | `/tv` form (server.py:1815) → POST `/tv`; page turns POST `/stream` | app/server.py |
| Tests | tests/*.py, tests/*.js, tools/check_authoring10.py | tests/ |
