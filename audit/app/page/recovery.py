"""Page-lane startup recovery: coordination, phase trace, ownership.

A turn is ABANDONED only when it is queued/running, its recorded worker pid is gone, and its
heartbeat is stale. Anything a live process owns - active or queued but heartbeat-fresh - is
left alone. Recovery never reruns tool work: it publishes a traceable failure.
"""
import errno, fcntl, json, os, time

PHASES = []
READY = {"ok": False, "error_id": None}
FRESH = 15.0


def _phase(name, **data):
    entry = {"phase": name, "ts": round(time.time(), 3), **data}
    PHASES.append(entry)
    return entry


def _alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except OSError as exc:
        return exc.errno == errno.EPERM


def classify(row, now=None):
    """abandoned | active | terminal"""
    now = now or time.time()
    if row.get("terminal"):
        return "terminal"
    if _alive(row.get("worker_pid")):
        return "active"
    hb = row.get("heartbeat") or row.get("created_at") or 0
    if now - float(hb) < FRESH:
        return "active"
    return "abandoned"


def recover(adapter, lock_path, now=None):
    """Returns dict(ready=bool, error_id=..., recovered=[...], skipped=[...])."""
    _phase("start")
    try:
        os.makedirs(os.path.dirname(lock_path), exist_ok=True)
        fh = open(lock_path, "w")
    except Exception as exc:
        _phase("lock_unavailable", detail=type(exc).__name__)
        return {"ready": False, "error_id": "recovery_lock_unavailable"}
    try:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            _phase("lock_acquired")
        except OSError as exc:
            _phase("lock_held_elsewhere", errno=exc.errno)
            return {"ready": False, "error_id": "recovery_in_progress"}
        _phase("scan_start")
        if not hasattr(adapter, "open_turns"):
            # The installed adapter owns its own recovery: it already distinguishes a turn its
            # own worker holds from one abandoned by a crash, and fails the abandoned ones.
            try:
                adapter.recover_interrupted()
                _phase("recovery_done", via="adapter")
                _phase("ready")
                READY.update(ok=True, error_id=None)
                return {"ready": True, "via": "adapter"}
            except Exception as exc:
                _phase("recovery_failed", detail=type(exc).__name__)
                READY.update(ok=False, error_id="recovery_failed")
                return {"ready": False, "error_id": "recovery_failed"}
        try:
            rows = list(adapter.open_turns())
        except Exception as exc:
            _phase("scan_failed", detail=type(exc).__name__)
            return {"ready": False, "error_id": "recovery_scan_failed"}
        _phase("scan_done", count=len(rows))
        recovered, skipped = [], []
        for row in rows:
            verdict = classify(row, now)
            if verdict == "abandoned":
                try:
                    adapter.fail(row, "abandoned_by_recovery")
                    recovered.append(row.get("turn"))
                except Exception as exc:
                    _phase("fail_failed", turn=row.get("turn"), detail=type(exc).__name__)
                    return {"ready": False, "error_id": "recovery_fail_failed"}
            else:
                skipped.append(row.get("turn"))
        _phase("recovery_done", recovered=len(recovered), skipped=len(skipped))
        _phase("ready")
        READY.update(ok=True, error_id=None)
        return {"ready": True, "recovered": recovered, "skipped": skipped}
    finally:
        try:
            fcntl.flock(fh, fcntl.LOCK_UN)
        except Exception:
            pass
        fh.close()


def gate():
    """None when page work may be served, otherwise a traceable reason."""
    return None if READY["ok"] else (READY["error_id"] or "recovery_pending")
