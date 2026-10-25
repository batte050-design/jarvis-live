"""Typed progress, throttled across workers and scoped to the full turn key."""
import json
import time
from .locks import root, KeyLock
from .store import key, atomic
STATES = {'checking_figures': 'Checking the figures', 'reading_source': 'Reading the source',
          'gathering_file': 'Gathering the file', 'computing': 'Working the numbers',
          'drafting': 'Drafting the answer'}
MIN_GAP = 3.0


def accept(state, owner, conv, session, turn, version):
    if not isinstance(state,str) or state not in STATES:
        raise ValueError('unsupported_progress_state')
    name = key(owner, conv, session, turn, version)
    marker = root() / ('progress-' + name + '.json')
    with KeyLock('progress', name):
        try:
            last = json.loads(marker.read_bytes())
        except FileNotFoundError:
            last = {}
        now = time.time()
        if now - last.get('ts', 0) < MIN_GAP or last.get('state') == state:
            return None
        ev = dict(state=state, line=STATES[state], ts=now, turn_id=turn, ephemeral=True)
        atomic(marker, ev)
        with open(root() / ('exec-' + name + '.jsonl'), 'a') as fh:
            fh.write(json.dumps(ev) + '\n')
        return ev
