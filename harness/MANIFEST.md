# Installed harness interfaces (source, for adapter implementation)

Revision: `f0d0955aa2` — the *installed* checkout, which is a deliberately dirty tree. These files are
the working-tree state the running adapter would bind to, not git HEAD.

Included:
- `agent/prompt_builder.py` — system prompt assembly (frozen prefix source)
- `acp_adapter/session.py` — session lifecycle, load/persistence
- `acp_adapter/server.py` — ACP handlers: session/new, session/load, session/prompt
- `acp_adapter/events.py`, `acp_adapter/auth.py` — event and auth plumbing the handlers use
- `tools/approval.py` — approval/permission dispatch and resume of a blocked tool call

Local modifications exist in `acp_adapter/*` in the installed tree; what is committed here is the
working-tree copy, which is what matters for binding.
