#!/bin/bash
# A leaked headless browser starves the machine: one tree opened ~226 processes and 45 tabs of
# yesterday's research, load hit 300, cloudflared could not keep its keepalives, Cloudflare dropped
# every connection at once and served its own 502 page instead of JARVIS. This keeps a browser tree
# from growing into a site-wide outage.
set -u
LIMIT=${1:-60}          # processes in one tree
TABS=${2:-25}           # open targets (pages and iframes)

for pat in "user-data-dir=/tmp/chrome-cdp" "user-data-dir=/tmp/jlprobe"; do
  n=$(pgrep -f "$pat" | wc -l)
  if [ "$n" -gt "$LIMIT" ]; then
    echo "$(date -Is) janitor: $pat has $n processes (limit $LIMIT) — clearing"
    pkill -9 -f "$pat"
    continue
  fi
  if [ "$pat" = "user-data-dir=/tmp/chrome-cdp" ]; then
    t=$(curl -s --max-time 4 http://127.0.0.1:9222/json/list | grep -c '"type"' || true)
    if [ "${t:-0}" -gt "$TABS" ]; then
      echo "$(date -Is) janitor: browser holds $t targets (limit $TABS) — clearing"
      pkill -9 -f "$pat"
    fi
  fi
done
# A probe browser left behind after a test is waste by definition.
pkill -9 -f "user-data-dir=/tmp/jlprobe" 2>/dev/null || true
echo "$(date -Is) janitor: cdp processes $(pgrep -f 'user-data-dir=/tmp/chrome-cdp' | wc -l), load $(cut -d' ' -f1 /proc/loadavg)"
