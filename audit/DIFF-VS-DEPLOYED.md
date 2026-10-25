# Snapshot vs deployed

Live build stamps: `{"js":"ba812b1587","css":"ed362e86f3","built":1792939197}`.
Every file in this snapshot was copied from the running tree at 2026-10-25 15:1x EAT and is
byte-identical to what is deployed **except** the three exceptions below.

| File | Difference | Why |
|---|---|---|
| app/server.py | personal email → `owner@example.com`, WhatsApp LID → `<operator-lid>@lid`, operator mobile → `+256700000000` | credentials and operator identity excluded from the public branch. server.py is not part of the presentation patch and is otherwise unchanged. |
| MANIFEST.json | added | hashes of every file in the snapshot |
| PATHMAP.md, FINDINGS.md, DIFF-VS-DEPLOYED.md | added | audit documents, not deployed |

The 15 deployed files that make up the chart/image change are byte-identical to the snapshot:
`check_install.py --after` reports MATCH against the same manifest used at install time.

Excluded from the snapshot entirely: `ctx/` (turn records, presentation store, receipts, profiles,
prefix hashes), `sessions.json`, `session.json`, `artifacts.json`, `audit.jsonl`, `executions.jsonl`,
`pending.json`, `chat_settings.json`, `modes.json`, `tombstones.json`, `logs/`, `web_guard.log`,
`outbox/`, device keys, tokens and `.env`.

The single conversation payload included is Mohammad's latest buildings answer, sanitized:
`payload/presentation-8094761b….json` (accepted payload) and `payload/turn-2ca8828f00000081.json`
(turn record without private runtime fields). No other conversation history is present.
