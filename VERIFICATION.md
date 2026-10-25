# review/page-steps — status of verification

BROWSER VERIFICATION: PENDING. Nothing here is promoted to live.

Proven on staging (measured, this branch's code):
- Two tool calls per turn, each opening and closing under the same ACP call ID.
- Canonical step rows now created (the previous misplaced branch appended only on journal overflow).
- Statuses distinct: running / completed / failed / cancelled.
- Transition journal replays every transition in order; overflow is counted (journal_omitted), not silent.
- Operation taken from ACP `kind` (values seen: execute, other), never from a display title.
- Operation cache is per-prompt on the agent instance, not a module global.

NOT proven:
- Summary rows updating in place during execution.
- Steps surviving completion and reload (overlay_history omits steps and skips non-ok turns).
- Attribution of a `running` step that never completes.
- Lazy MCP connection (baseline preserved; not attempted here).

STAGING-ONLY: /api/dev/run exists on staging and is stripped from live. Identifiers in this
tree are placeholders; the live tree keeps real values.
