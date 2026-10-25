"""POSIX cross-process locks; keys use canonical tuples, never Python hash()."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import time


def root():
    path = Path(os.environ['PRESENT_STORE'])
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def digest(parts):
    return hashlib.sha256(json.dumps(parts, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


class KeyLock:
    def __init__(self, namespace, key, timeout=30.0):
        self.path = root() / ('lock-' + digest([namespace, key]))
        self.timeout = timeout
        self.fh = None

    def __enter__(self):
        self.fh = os.fdopen(os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600), 'a+')
        deadline = time.monotonic() + self.timeout
        try:
            while True:
                try:
                    fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return self
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('lock_timeout')
                    time.sleep(0.02)
        except BaseException:
            self.fh.close()
            raise

    def __exit__(self, *exc):
        try:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
        finally:
            self.fh.close()
