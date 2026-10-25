# JARVIS Live — handoff, 2026-10-25

Branch `review/live-handoff-20261025`. Everything read from the running system at packing time. Credentials and operator identities redacted; nothing else altered.

## 1. Live snapshot

- Live worktree `/data/apps/jarvis-live` (deliberately dirty; deploys land on working files, never git HEAD)
- Live git HEAD (reference only): `8c4c9afcb06a`
- Build stamps from `/build`: `{"js":"159e5556db","css":"ed362e86f3","built":1792913848}`
- Application snapshot: `handoff/20261025/live/`; harness: `handoff/20261025/harness/`; digests: `MANIFEST.json`

### File hashes (sha256, first 16)

| File | sha256_16 |
|---|---|
| server.py | 9216843ab44aa165 |

| page/adapter.py | 29c085aee8c05fd6 |

| page/legacy.py | 402f8c02c6f54b26 |

| page/driver.py | 1820dc8b7d3f39de |

| page/warm_agent.py | 7974ed2127976b4a |

| page/recovery.py | be83c96f066ecdc4 |

| page/bootstrap.py | cb9bb4074c797072 |

| index.html | 66b0fb7368680b11 |

| index_v1.html | da255c5f048320fa |

| static/v1.js | 159e5556db8d59c6 |

| response_openui.py | 3ee8a826e0b5432b |

| response_layer.py | c2ac78bedf8ddb9a |


### Differences from disk

Six files were changed while packing, redaction only: `batte050@gmail.com`→`owner@example.com`, `jarvis@battemohammad.com`→`jarvis@example.com`, operator WhatsApp LID→`<operator-lid>@lid`, Ugandan mobiles (`+2567…`,`07…`)→placeholder, and any token/secret/api_key/password value→`[REDACTED]`. No logic or build output touched.

## 2. Private trace — `f5f82f97f0364d30ab018f0fcb758ec1`

| Field | Value |
|---|---|
| conversation | `99ee2fbec25cf3ba1c14d7b658d29741` |
| turn | `189b14af00000052` |
| harness session | `0c51d157-a480-4044-9cc2-f59676ecc903` |
| question | Show me the world's tallest buildings. |
| created | 2026-10-25 12:56:24 EAT (epoch 1792932984.624) |
| terminal | `failed`, event `failure`, id `189b14af00000052:terminal` |
| timing | complete 66,544 ms; first_progress 1,977 ms; first_content null |
| record | `ctx/page-presentation/turns/f874476d4a92ec474864b96f0a940c3390c7a55a32f6fb52f00866f4591fe893.json` |
| rev / version | 18 / 1.2.0; approval null; cancelled false |

### Tool lifecycle

| seq | call id | action | status |
|---|---|---|---|
| 1 | tc-0a3c3b05866d | Reading a page | completed |
| 2 | tc-21076631d700 | Working | completed |
| 3 | tc-1f08b394744f | Reading a page | **failed** |
| 4 | tc-de4708b3d3f5 | Working | **failed** |
| 5 | tc-71dd72b5f4ff | Running a command | completed |
| 6 | tc-2d65fdf0588a | Running a command | completed |
| 7 | tc-7dd8ae93eacb | Working | completed |
| 8 | tc-86946f8b2b15 | Working | completed |
| 9 | tc-c2c8ac168c18 | Working | completed |

### emit_ui attempts and validation

None. `current_progress` null, no presentation record, so the harness never reached emission — the failure is upstream of `emit_ui`.

### Original exception and traceback (same window)

```
File "/data/apps/jarvis-live/server.py", line 8433, in api_sessions
    PAGE_TEXT.overlay_history()
File "/data/apps/jarvis-live/page/legacy.py", line 168, in overlay_history
    'a': self.answer(terminal['payload']) if (terminal.get('payload')) else (terminal.get('message') or ''),
AttributeError: 'NoneType' object has no attribute 'get'
```

`terminal` was None for a turn with no terminal payload, so the session-list refresh crashed on every poll. Fixed on live: `terminal` is `row.get('terminal') or {}`, `timing` read defensively, `request.question` guarded. Verified after restart: `/api/sessions` 200 with 5 entries.

### Terminal result

```
page turn failed error_id=f5f82f97f0364d30ab018f0fcb758ec1 code=harness_failed turn=189b14af00000052   (2026-10-25 12:57:31)
```

Two browser "Reading a page" calls failed inside the turn — consistent with the browser tool aimed at a CDP port with no browser. No ACP child stderr survived; the turn record above is the durable evidence.

## 3. Harness execution code

Installed tree `/home/ubuntu/.hermes/hermes-agent`, upstream HEAD `f0d0955aa2c4`. Shipped: `acp_adapter/session.py` (session creation, page toolset expansion), `acp_adapter/server.py` (ACP server, set_config_option, reasoning branch), `acp_adapter/page_presentation.py` (emit_ui/emit_progress definitions and validation), `agent/prompt_builder.py`, `agent/system_prompt.py`, `tools/approval.py`, `tools/mcp_schema_cache.py`, `plugins/page_presentation/`. `LOCAL-MODIFICATIONS.patch` is the restricted `git diff HEAD`, so it carries the real local edits, not an upstream pointer. The whole-tree diff is unusable because the checkout is rebranded (~1,300 files), and the patch mirror is stale.

## 4. Launch configuration

```
Unit             systemctl --user jarvis-live
ExecStart        /data/apps/jarvis-live/venv/bin/python /data/apps/jarvis-live/server.py
WorkingDirectory /data/apps/jarvis-live
Restart          always, RestartSec=3
Port             127.0.0.1:8150  (public https://live.battemohammad.com via cloudflared)
Python           /data/apps/jarvis-live/venv/bin/python (3.11)
Node             /home/ubuntu/.hermes/node/bin/node
Lookup python    /home/ubuntu/.hermes/hermes-agent/venv/bin/python
Harness home     /home/ubuntu/.hermes
Engine binary    /home/ubuntu/.hermes/hermes-agent/hermes
```

Environment (names, non-secret values):

```
JARVIS_LIVE_PORT=8150
JARVIS_OPENUI_NODE=/home/ubuntu/.hermes/node/bin/node
JARVIS_LOOKUP_PYTHON=/home/ubuntu/.hermes/hermes-agent/venv/bin/python
JARVIS_WEB_GUARD=ask
JARVIS_AUTO_APPROVE_ENABLED=0
JARVIS_WARM_AGENT=1
PYTHONUNBUFFERED=1
```

`JARVIS_AUTO_APPROVE_ENABLED=0` is deliberate — outbound sends must ask. `JARVIS_WARM_AGENT=1` is deliberate — at 0 the first turn cost 50 s; at 1 identity answers in 8.9 s and a filesystem check in 11.9 s.

Timeouts: page adapter turn deadline 480 s; title generation 3 s, provider `auto`, local `qwen2.5:7b` at `127.0.0.1:11434`. MCP: 11 servers, all `lazy: true`, one (`twelve-data`) fails OAuth non-interactively.

## 5. Access for verification

- Device keys: `/home/ubuntu/.hermes/jarvis_live_devices.txt`; the `gpt-openui-review` entry is still present, scope `full`.
- Permitted live endpoints: `/`, `/tv` (pairing), `/stream` (turn SSE), `/api/agent/prestart/{conv}`, `/api/sessions`, `/build`, `/static/*`, `/vendor/*`.
- Auth: device key in cookie `jl`; `Origin` must be `https://live.battemohammad.com` — loopback calls presenting the public Origin are refused by design.
- Fresh code: `POST /tv/mint`, redeemed at `POST /tv` with field `code`, grants scope `full`. Only one live code exists at a time.

## 6. Rollback

Known-working backup: `/data/backups/jarvis-live-pre-steps-20261025-1109` (server.py + page/). Earlier anchor: `/data/backups/jarvis-live-pre-pagegate-20261025-1103`.

```
systemctl --user stop jarvis-live
B=/data/backups/jarvis-live-pre-steps-20261025-1109
cp -f $B/server.py /data/apps/jarvis-live/server.py
rsync -a --delete $B/page/ /data/apps/jarvis-live/page/
python3 -c "import ast;ast.parse(open('/data/apps/jarvis-live/server.py').read())"
systemctl --user start jarvis-live
curl -s -o /dev/null -w '%{http_code}' https://live.battemohammad.com/
```

That preimage predates the `overlay_history` None-guard — re-apply it after restoring, or the session list crashes again on a turn with no terminal payload.

