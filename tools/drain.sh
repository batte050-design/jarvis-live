#!/usr/bin/env bash
# Wait for a turn in flight to finish before a stop actually lands.
#
# The server's uvicorn is deliberately given a 3-second graceful window (an open SSE stream would
# otherwise hold the process open until systemd lost patience). The cost of that cap is that a
# plain restart cuts whatever turn is being watched mid-answer, and the page has nothing to show
# for it. This runs as ExecStop, i.e. BEFORE systemd sends the kill signal, so the turn finishes
# normally and the page never sees a break at all. (ExecStopPre does not exist in systemd and is
# ignored silently, which is worth knowing: a drain can look installed and never run.)
#
# Capped on purpose: a wedged turn must not be able to hold a restart forever. systemd's own stop
# timeout is the second backstop. Exits 0 either way, so a probe failure can never block a stop.
set -u

PORT="${JARVIS_LIVE_PORT:-8150}"
CAP_S="${JARVIS_LIVE_DRAIN_S:-300}"
DEADLINE=$((SECONDS + CAP_S))

while [ $SECONDS -lt $DEADLINE ]; do
    TURNS="$(curl -s -m 2 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null \
             | tr -d ' ' | sed -n 's/.*"turns":\([0-9][0-9]*\).*/\1/p')"
    # No answer, or no field: the server is gone or wedged. Let the stop proceed.
    [ -z "${TURNS:-}" ] && exit 0
    if [ "$TURNS" -le 0 ]; then
        exit 0
    fi
    echo "[drain] $TURNS turn(s) in flight, waiting up to ${CAP_S}s before stopping"
    sleep 2
done

echo "[drain] still busy after ${CAP_S}s; letting the stop proceed"
exit 0
