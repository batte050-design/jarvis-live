"""Single-decision approvals; pending actions remain private and immutable."""
import json
import re
import time
import uuid
from .locks import root, KeyLock
from .store import atomic

CHOICES = ['approve_once', 'deny']
PUBLIC = ('id', 'turn_id', 'operation', 'target', 'reason', 'effect', 'expires_at', 'choices')


def _path(aid):
    if not isinstance(aid, str) or not re.fullmatch('[0-9a-f]{32}', aid):
        raise ValueError('unknown_approval')
    return root() / 'approvals' / (aid + '.json')


def create(owner, conv, session, turn_id, operation, target, reason, effect, arguments, ttl=300):
    aid = uuid.uuid4().hex
    rec = dict(id=aid, turn_id=turn_id, operation=operation, target=target, reason=reason,
               effect=effect, choices=CHOICES, expires_at=time.time()+min(max(ttl, 0), 300),
               owner=owner, conv=conv, session=session, arguments=arguments, consumed=False)
    atomic(_path(aid), rec, exclusive=True)
    return {k: rec[k] for k in PUBLIC}


def read(aid):
    try:
        return json.loads(_path(aid).read_bytes())
    except FileNotFoundError:
        raise ValueError('unknown_approval') from None


def decide(aid, decision, owner, conv):
    with KeyLock('approval', aid):
        rec = read(aid)
        if rec['owner'] != owner or rec['conv'] != conv:
            raise PermissionError('cross_owner_approval')
        if rec['consumed']:
            raise ValueError('already_consumed')
        if time.time() >= rec['expires_at']:
            raise ValueError('approval_expired')
        if decision not in CHOICES:
            raise ValueError('invalid_decision')
        rec.update(consumed=True, decision=decision, decided_at=time.time())
        atomic(_path(aid), rec)
        # Return no private arguments to the browser endpoint.
        return {'id': aid, 'decision': decision}


def resolution(aid, owner, conv, session, turn_id):
    rec = read(aid)
    if [rec['owner'], rec['conv'], rec['session'], rec['turn_id']] != [owner, conv, session, turn_id]:
        raise PermissionError('approval_turn_mismatch')
    if rec['consumed']:
        return rec['decision']
    if time.time() >= rec['expires_at']:
        return 'deny'
    return None
