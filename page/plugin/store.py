"""Immutable accepted payloads, keyed by owner, conversation, session, turn and version."""
import json, os, hashlib, time, pathlib

ROOT = pathlib.Path(os.environ.get("PRESENT_STORE", "/data/apps/jarvis-live-staging/ctx/present"))
ROOT.mkdir(parents=True, exist_ok=True)

def _key(owner, conv, session, turn, version):
    raw = "|".join([owner or "", conv or "", session or "", str(turn or ""), version or ""])
    return hashlib.sha256(raw.encode()).hexdigest()[:32]

def put(payload, owner, conv, session, turn, version):
    rec = {"payload": payload, "owner": owner, "conv": conv, "session": session,
           "turn": turn, "version": version, "written_utc": time.time(),
           "sha256": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()}
    path = ROOT / (_key(owner, conv, session, turn, version) + ".json")
    if path.exists():
        # Only an ACCEPTED payload reserves the turn. A rejected submission never calls put(),
        # so the repair submission that follows it still lands here.
        raise RuntimeError("emit_ui_twice_for_turn")
    # Two guarantees at once. The bytes are written to a temp file and fsynced before the
    # record exists under its real name, so a killed writer leaves NO record rather than a
    # truncated one. os.link is then the create-if-absent step: it fails with EEXIST if a
    # second writer got there first, which os.replace would have silently overwritten.
    tmp = path.with_suffix(".part-%d" % os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(json.dumps(rec).encode())
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.link(tmp, path)
    except FileExistsError:
        raise RuntimeError("emit_ui_twice_for_turn")
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return rec


    return rec

def get(owner, conv, session, turn, version):
    path = ROOT / (_key(owner, conv, session, turn, version) + ".json")
    return json.loads(path.read_text()) if path.exists() else None
