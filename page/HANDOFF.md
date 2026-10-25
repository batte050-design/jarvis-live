# Source handoff — presentation channel, adapter primitives

Not a deployment. Nothing here is live. Staging build at the time of handoff:
`js 159e5556db` / `css ed362e86f3` / built `1792896347`.
Live tree commit: `1c06fdf` (staging working tree, deliberately dirty).

## What is in this branch

- `page/plugin/` — the `page_presentation` harness plugin: `__init__.py` (emit_ui, emit_progress),
  `store.py` (immutable accept record), `locks.py` (cross-process key lock), `approvals.py`
  (bound approval requests), `progress.py` (fixed state table), `plugin.yaml`, `version.json`,
  `openui_validate_once.py` (validation entry the tool calls).
- `page/server.py` — the page server as it stands, for the current provider branch and the
  existing warm-agent bridge.
- `page/warm_agent.py` — the bridge: session creation, streaming callbacks, completion.

## Harness interfaces the adapter must use

| Concern | Where it lives |
|---|---|
| Session creation | `warm_agent.py::WarmAgent.__init__` / `_start`, one ACP child per session name |
| Prompt assembly, frozen prefix | harness `agent/prompt_builder.py`, assembled once per session; never mutated mid-conversation |
| Completion events | `warm_agent.py::_translate_update` (text, tool_use, tool_result) and the ACP turn-end notification |
| Tool registration | `ctx.register_tool(name, toolset, schema, handler, emoji)` — as used by `page/plugin/__init__.py::register` |

The approval resumption path is **not yet implemented** in this handoff; `approvals.py` defines
the record and the decision rules it must obey.

## Traps this handoff confirms

1. `warm_agent.py` selects permission options automatically, including session-wide approval.
   The page path must not inherit that: it must route through `approvals.py`.
2. `warm_agent.py` forwards tool arguments, outputs and narration through its callbacks. The page
   path must emit only the permitted progress states and the validated presentation record.

## Proven here, with the tests that prove it

- rejection → repair → acceptance → duplicate refusal (same turn)
- duplicate acceptance refused by `O_EXCL`/`os.link`, not by a check-then-write
- a writer killed mid-acceptance leaves no record; retrieval returns nothing
- two OS processes contend on the session lock (1.21 s held) — a `hash()`-keyed lock did not
- approvals refuse cross-owner, already-consumed and expired decisions
- progress refuses free text and throttles to one event per 3 s

## Not done

Adapter wiring, terminal publish gating, disconnect/reconnect upsert, the three end-to-end
proofs, and the provider-call provenance assertion.
