"""Immutable, durable, integrity-checked accepted payloads."""
import hashlib
import json
import os
import tempfile
import time
from .locks import root, digest


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def key(owner, conv, session, turn, version):
    values = [owner, conv, session, turn, version]
    if not all(isinstance(v, str) and v and len(v) <= 256 for v in values):
        raise ValueError('missing_or_invalid_turn_binding')
    return digest(values)


def atomic(path, value, *, exclusive=False):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as fh:
            fh.write(canonical(value))
            fh.flush()
            os.fsync(fh.fileno())
        if exclusive:
            os.link(tmp, path)
        else:
            os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def put(payload, owner, conv, session, turn, version):
    name = key(owner, conv, session, turn, version)
    if payload.get('version') != version:
        raise ValueError('presentation_version_mismatch')
    rec = dict(payload=payload, owner=owner, conv=conv, session=session, turn=turn,
               version=version, written_utc=time.time(), sha256=hashlib.sha256(canonical(payload)).hexdigest())
    try:
        atomic(root() / (name + '.json'), rec, exclusive=True)
    except FileExistsError:
        raise RuntimeError('emit_ui_twice_for_turn') from None
    return rec


def get(owner, conv, session, turn, version):
    path = root() / (key(owner, conv, session, turn, version) + '.json')
    try:
        rec = json.loads(path.read_bytes())
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeError):
        raise ValueError('presentation_record_corrupt') from None
    expected = dict(owner=owner, conv=conv, session=session, turn=turn, version=version)
    if any(rec.get(k) != v for k, v in expected.items()) or rec.get('payload', {}).get('version') != version:
        raise ValueError('presentation_record_binding_mismatch')
    if rec.get('sha256') != hashlib.sha256(canonical(rec['payload'])).hexdigest():
        raise ValueError('presentation_record_hash_mismatch')
    return rec
