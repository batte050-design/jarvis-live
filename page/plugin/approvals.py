"""Approval requests, bound server-side to the exact pending action.

The page sends only an id and a decision. Arguments cannot be substituted, an expired or
cross-owner decision is refused, and an approval is consumed by the action it authorised.
"""
import json, os, time, uuid, pathlib

ROOT = pathlib.Path(os.environ.get("PRESENT_STORE", "/data/apps/jarvis-live-staging/ctx/present")) / "approvals"
ROOT.mkdir(parents=True, exist_ok=True)
CHOICES = ["approve_once", "deny"]


def create(owner, conv, session, turn_id, operation, target, reason, effect, arguments, ttl=300):
    aid = uuid.uuid4().hex[:24]
    rec = {"id": aid, "turn_id": turn_id, "operation": operation, "target": target,
           "reason": reason, "effect": effect, "choices": CHOICES,
           "expires_at": time.time() + ttl, "owner": owner, "conv": conv,
           "session": session, "arguments": arguments, "consumed": False}
    (ROOT / (aid + ".json")).write_text(json.dumps(rec))
    return {k: rec[k] for k in ("id", "turn_id", "operation", "target", "reason", "effect",
                                "expires_at", "choices")}


def decide(aid, decision, owner, conv):
    path = ROOT / (aid + ".json")
    if not path.exists():
        raise ValueError("unknown_approval")
    rec = json.loads(path.read_text())
    if rec["owner"] != owner or rec["conv"] != conv:
        raise PermissionError("cross_owner_approval")
    if rec["consumed"]:
        raise ValueError("already_consumed")
    if time.time() > rec["expires_at"]:
        raise ValueError("approval_expired")
    if decision not in CHOICES:
        raise ValueError("invalid_decision")
    rec["consumed"] = True
    rec["decision"] = decision
    rec["decided_at"] = time.time()
    path.write_text(json.dumps(rec))
    return rec
