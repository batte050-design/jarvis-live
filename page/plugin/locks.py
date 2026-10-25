"""Cross-process locks. A thread lock is not enough: the page runs several workers."""
import fcntl, hashlib, os, pathlib, time

ROOT = pathlib.Path(os.environ.get("PRESENT_STORE", "/data/apps/jarvis-live-staging/ctx/present"))
ROOT.mkdir(parents=True, exist_ok=True)


class KeyLock:
    """One holder per key across processes. Blocks until free, then holds until released."""

    def __init__(self, namespace, key, timeout=30.0):
        # hashlib, not hash(): str hash is randomised per process, so two workers would
        # have taken different lock files and never contended.
        self.path = ROOT / ("lock-%s-%s" % (namespace, hashlib.sha256(key.encode()).hexdigest()[:24]))
        self.timeout = timeout
        self.fh = None

    def __enter__(self):
        self.fh = open(self.path, "a+")
        deadline = time.time() + self.timeout
        while True:
            try:
                fcntl.flock(self.fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.time() > deadline:
                    raise TimeoutError("lock_timeout")
                time.sleep(0.02)

    def __exit__(self, *exc):
        try:
            fcntl.flock(self.fh, fcntl.LOCK_UN)
        finally:
            self.fh.close()
        return False
