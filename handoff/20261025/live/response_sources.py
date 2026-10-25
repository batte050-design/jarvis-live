"""Turn-owned, bounded evidence for text response series. No persistent state."""
import contextlib
import contextvars
import copy
import datetime as dt
from decimal import Decimal
import hashlib
import hmac
import json
import logging
import math
import os
import re
import secrets
import threading
import tempfile
import time
import urllib.parse
import urllib.request

LOG = logging.getLogger(__name__)
CURRENT = contextvars.ContextVar('response_series_evidence', default=None)
LIMITS = {'payloadBytes': 262144, 'points': 64, 'dailyPoints': 800, 'receipts': 2,
          'timeoutSeconds': 10, 'queryChars': 1024, 'historyDays': 732, 'charts': 1}
_TEXT_LOCK = threading.Lock()
_TEXT_JOBS = 0
PUBLISHER = contextvars.ContextVar('response_publisher', default=None)
_PUBLISHERS = {}
_PUBLISHER_LOCK = threading.RLock()


@contextlib.contextmanager
def publisher(mode, conv=''):
    """A server-minted capability lives only for the helper that owns this publication."""
    current = PUBLISHER.get()
    if current is not None:
        with _PUBLISHER_LOCK: record = _PUBLISHERS.get(current['turn'])
        if record and record['mode'] == mode and record['conv'] == str(conv or ''):
            yield copy.deepcopy(current)
            return
    if mode not in ('text', 'voice'): raise ValueError('publisher mode')
    public = {'turn': secrets.token_hex(16), 'conv': str(conv or ''), 'token': secrets.token_hex(32)}
    now = time.monotonic()
    with _PUBLISHER_LOCK:
        for key, record in list(_PUBLISHERS.items()):
            if now >= record['expires']: del _PUBLISHERS[key]
        if len(_PUBLISHERS) >= 64: raise ValueError('publisher capacity')
        _PUBLISHERS[public['turn']] = {**public, 'mode': mode, 'expires': now + 600}
    token=[REDACTED](public)
    try:
        yield copy.deepcopy(public)
    finally:
        with _PUBLISHER_LOCK: _PUBLISHERS.pop(public['turn'], None)
        PUBLISHER.reset(token)


def publisher_context():
    return copy.deepcopy(PUBLISHER.get())


def bind_publisher(path):
    """Refresh the existing warm-child context atomically, retaining its permission fields."""
    if not path: raise ValueError('publisher context path missing')
    with open(path, encoding='utf-8') as source:
        text = source.read(32769)
    if len(text.encode()) > 32768: raise ValueError('publisher context budget')
    value = json.loads(text)
    if not isinstance(value, dict): raise ValueError('publisher context shape')
    value['JARVIS_SCREEN_PUBLICATION'] = publisher_context()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=os.path.dirname(os.path.abspath(path)), delete=False) as out:
            temporary = out.name
            json.dump(value, out)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary): os.unlink(temporary)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False)


def utcnow():
    return dt.datetime.now(dt.timezone.utc)


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or abs(value) > 10**9:
        raise ValueError('invalid series number')
    return Decimal(str(value))


def points_ok(points, supplied=False):
    if not isinstance(points, list) or not 1 <= len(points) <= LIMITS['points']:
        raise ValueError('series point budget')
    labels, values = set(), set()
    for point in points:
        if not isinstance(point, dict) or set(point) != {'label', 'value'}:
            raise ValueError('series point shape')
        label = point['label']
        if not isinstance(label, str) or not label.strip() or len(label) > 80 or re.search(r'[\x00-\x1f]', label):
            raise ValueError('series label')
        value = number(point['value'])
        if label in labels: raise ValueError('duplicate period')
        if not supplied and value in values: raise ValueError('repeated series value; no fill permitted')
        labels.add(label); values.add(value)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('series redirect refused')


def fetch_yahoo(query):
    """A fixed HTTPS upstream. Model strings cannot choose a host, URL or credentials."""
    symbol = query['symbol']
    if not re.fullmatch(r'[A-Za-z0-9^=.-]{1,24}', symbol): raise ValueError('unsupported series symbol')
    start, end = (dt.date.fromisoformat(query[k]) for k in ('start', 'end'))
    p1 = int(dt.datetime.combine(start, dt.time(), dt.timezone.utc).timestamp())
    p2 = int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time(), dt.timezone.utc).timestamp())
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + urllib.parse.quote(symbol, safe='')
    url += '?' + urllib.parse.urlencode({'period1': p1, 'period2': p2, 'interval': '1d'})
    request = urllib.request.Request(url, headers={'User-Agent': 'JARVIS-Series/1', 'Accept': 'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=LIMITS['timeoutSeconds']) as response:
        raw = response.read(LIMITS['payloadBytes'] + 1)
    if len(raw) > LIMITS['payloadBytes']: raise ValueError('upstream byte budget')
    return json.loads(raw)


def yahoo_points(payload, query, now):
    if not isinstance(payload, dict): raise ValueError('upstream object required')
    chart = payload.get('chart') or {}
    results = chart.get('result')
    if chart.get('error') or not isinstance(results, list) or len(results) != 1:
        raise ValueError('upstream returned no series')
    result = results[0]
    if result.get('meta', {}).get('symbol') != query['symbol']:
        raise ValueError('upstream symbol mismatch')
    times = result.get('timestamp') or []
    quotes = result.get('indicators', {}).get('quote') or []
    closes = quotes[0].get('close') if len(quotes) == 1 else None
    if not isinstance(closes, list) or len(closes) != len(times) or not 1 <= len(times) <= LIMITS['dailyPoints']:
        raise ValueError('upstream dates and closes mismatch')
    start, end = (dt.date.fromisoformat(query[k]) for k in ('start', 'end'))
    by_date = {}
    for timestamp, close in zip(times, closes):
        if type(timestamp) not in (int, float) or not math.isfinite(timestamp): raise ValueError('upstream timestamp')
        when = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc)
        date = when.date()
        slack = dt.timedelta(days=2)
        if date < start - slack or date > end + slack: raise ValueError('upstream point outside query')
        if when > now: raise ValueError('future observation')
        if date < start or date > end: continue
        if date in by_date: raise ValueError('duplicate upstream date')
        # Null closes are gaps, never zero, forward fill or a friendly rounded guess.
        by_date[date] = None if close is None else number(close)
    def bucket_by(period):
        out = {}
        for date, close in sorted(by_date.items()):
            if close is None:
                continue
            label = date.strftime('%Y-%m') if period == 'month' else date.isoformat()
            out.setdefault(label, []).append(close)
        return out

    # A long daily window can exceed the plotted-point budget. Falling back to monthly means keeps
    # the series honest and labelled, instead of refusing a request the reader can see is chartable.
    period = query['period']
    buckets = bucket_by(period)
    if len(buckets) > LIMITS['points']:
        period = 'month'
        buckets = bucket_by(period)
    points = [{'label': label, 'value': float(sum(values) / len(values))} for label, values in buckets.items()]
    points_ok(points)
    expected = set()
    date = start
    while date <= end:
        expected.add(date.strftime('%Y-%m') if period == 'month' else date.isoformat())
        date += dt.timedelta(days=1)
    missing = sorted(expected - set(buckets))
    through = max(date for date, close in by_date.items() if close is not None).isoformat()
    aggregation = ('mean of available daily closes' if period == 'month' else 'daily close')
    symbol = query['symbol']
    label = symbol[:3] + ' per USD' if re.fullmatch(r'[A-Z]{3}=X',symbol) else symbol
    title = label + (' monthly observed means' if period == 'month' else ' daily closes')
    return points, through, missing, aggregation, title


def supplied_points(question):
    """Read only explicitly paired label/number literals from this request, never agent prose."""
    body = question.split(':', 1)[-1]
    pairs = []
    for part in re.split(r';|,(?!\d{3}(?:\D|$))', body):
        match = re.search(r'([A-Za-z][A-Za-z -]{0,39}?)\s+(?:[A-Z]{3}\s+)?([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:[.;]|$)', part.strip())
        if match:
            label = match[1].strip()
            # Instructions preceding a month/field are not part of the label.
            label = re.sub(r'^.*?\b(income|housing|food|other(?: expenses)?|January|February|March|April|May|June|July|August|September|October|November|December)\b', r'\1', label, flags=re.I)
            pairs.append({'label': label, 'value': float(Decimal(match[2].replace(',', '')))})
    if not pairs: raise ValueError('no explicit supplied label/value pairs')
    if len(pairs) > LIMITS['points']: raise ValueError('supplied series point budget')
    return pairs


class Evidence:
    def __init__(self, question, network=False, fetch=None, clock=None):
        self.question = str(question)
        self.network = network
        self.fetch = fetch or fetch_yahoo
        self.clock = clock or utcnow
        self.receipts = {}
        self.published = 0
        self.started = self.clock()

    def retrieve(self, query):
        if len(self.receipts) >= LIMITS['receipts']: raise ValueError('retrieval count budget')
        if not isinstance(query, dict) or set(query) != {'provider', 'symbol', 'start', 'end', 'period'}:
            raise ValueError('retrieval argument shape')
        if query['provider'] == 'user_input':
            points = supplied_points(self.question)
            points_ok(points, supplied=True)
            payload = {'question': self.question, 'points': points}
            tool, kind, through, missing, aggregation, title = 'read_user_input', 'provided', '', [], 'supplied figures', 'Supplied figures'
            exact_query = self.question
        elif query['provider'] == 'yahoo_chart':
            if not self.network: raise ValueError('web retrieval is disabled for this turn')
            start, end = (dt.date.fromisoformat(query[k]) for k in ('start', 'end'))
            if query['period'] not in ('day', 'month') or not 0 <= (end-start).days <= LIMITS['historyDays'] or end > self.clock().date():
                raise ValueError('invalid retrieval date range')
            span = re.search(r'\b(?:past|last)\s+(\d+)\s+(day|week|month|year)s?\b', self.question, re.I)
            if span:
                amount, unit = int(span[1]), span[2].lower()
                wanted_end = self.started.date()
                if unit in ('day','week'):
                    wanted_start = wanted_end - dt.timedelta(days=amount*(7 if unit=='week' else 1))
                else:
                    months = amount*(12 if unit=='year' else 1)
                    year, month = divmod(wanted_end.year*12+wanted_end.month-1-months,12)
                    import calendar
                    wanted_start = dt.date(year,month+1,min(wanted_end.day,calendar.monthrange(year,month+1)[1]))
                # A model-stated window that lands within a few days of the one the wording implies
                # is the same request. Exact equality refused honest charts over a day's rounding.
                if abs((start-wanted_start).days) > 3 or abs((end-wanted_end).days) > 3:
                    raise ValueError('retrieval window differs from request')
            if re.search(r'\busd\b',self.question,re.I) and re.search(r'\bugx\b',self.question,re.I) and query['symbol'] != 'UGX=X':
                raise ValueError('requested currency pair differs')
            payload = self.fetch(copy.deepcopy(query))
            if len(canonical(payload).encode()) > LIMITS['payloadBytes']: raise ValueError('upstream byte budget')
            points, through, missing, aggregation, title = yahoo_points(payload, query, self.clock())
            tool, kind, exact_query = 'yahoo_chart', 'retrieved', canonical(query)
        else:
            raise ValueError('retrieval provider denied')
        if len(exact_query) > LIMITS['queryChars']: raise ValueError('source query budget')
        source = {'kind': kind, 'tool': tool, 'query': exact_query, 'timestamp': stamp(self.clock()),
                  'retrieval_id': secrets.token_hex(16), 'sha256': hashlib.sha256(canonical(payload).encode()).hexdigest(),
                  'observed_through': through, 'missing': missing, 'aggregation': aggregation}
        receipt = {'source': source, 'points': points, 'title': title}
        self.receipts[source['retrieval_id']] = copy.deepcopy(receipt)
        return copy.deepcopy(receipt)

    def checked(self, source):
        if not isinstance(source, dict): raise ValueError('source object required')
        receipt = self.receipts.get(source.get('retrieval_id'))
        if not receipt or canonical(source) != canonical(receipt['source']):
            raise ValueError('source is not a retrieval in this turn')
        return copy.deepcopy(receipt)

    def check_points(self, source, points):
        receipt = self.checked(source)
        points_ok(points, supplied=receipt['source']['kind'] == 'provided')
        if len(points) != len(receipt['points']) or any(p['label'] != r['label'] or number(p['value']) != number(r['value']) for p,r in zip(points,receipt['points'])): raise ValueError('plotted values differ from retrieval')
        return receipt

    def publish(self):
        if self.published >= LIMITS['charts']: raise ValueError('one chart per request')
        self.published += 1


@contextlib.contextmanager
def turn(question, network=False, fetch=None, clock=None, presentation=False):
    global _TEXT_JOBS
    existing = CURRENT.get()
    if existing is not None:
        yield existing
        return
    evidence = Evidence(question, network, fetch, clock)
    token = CURRENT.set(evidence)
    if presentation:
        with _TEXT_LOCK: _TEXT_JOBS += 1
    try:
        yield evidence
    finally:
        if presentation:
            with _TEXT_LOCK: _TEXT_JOBS -= 1
        CURRENT.reset(token)


def artifact_allowed(payload):
    # A master transport token identifies the tool, not the turn. Text never owns this channel.
    # The model cannot choose a mode, mint a grant or reuse a grant after its helper finishes.
    grant = payload.get('publication')
    if not isinstance(grant, dict) or set(grant) != {'turn', 'conv', 'token'}: return False
    if not all(isinstance(value, str) for value in grant.values()): return False
    with _PUBLISHER_LOCK:
        record = _PUBLISHERS.get(grant['turn'])
        return bool(record and record['mode'] == 'voice' and time.monotonic() < record['expires']
                    and grant['conv'] == record['conv'] and hmac.compare_digest(grant['token'], record['token']))


def unavailable(question, reason='a dated, verifiable series was not returned'):
    asked = re.sub(r'[\x00-\x1f`]', ' ', str(question))[:350]
    if any(c in asked for c in ('{','[','~~~')): asked = 'a chart from the requested figures'
    return ('You asked: ' + asked + '\n\nI could not source the requested figures: ' + reason +
            '. No chart or estimate was produced. I would need a dated series from a supported feed, or your explicit label/value data.')


def consistent(prose, points, decimals=2):
    """Reject labeled numeric restatements outside the display rounding interval."""
    tolerance = Decimal(1).scaleb(-decimals) / 2
    for point in points:
        label = re.escape(point['label'])
        for match in re.finditer(label + r'\s*[:=]?\s*([-+]?\d[\d,]*(?:\.\d+)?)', prose, re.I):
            if abs(Decimal(match[1].replace(',', '')) - number(point['value'])) > tolerance:
                raise ValueError('prose and card figures disagree')
    return True


def is_series(spec):
    if not isinstance(spec, dict): return False
    outputs = spec.get('outputs')
    return spec.get('type') == 'chart' or spec.get('component') in ('chart', 'budget-planner') or (isinstance(outputs, list) and any(isinstance(o, dict) and o.get('kind') == 'chart' for o in outputs))


def check_spec(spec):
    """Final text content gate; model-authored receipts cannot authorize a chart."""
    if not is_series(spec): return spec
    context = CURRENT.get()
    if context is None: raise ValueError('no turn evidence for chart')
    source = spec.get('source')
    if not isinstance(source, dict): raise ValueError('source object required')
    if source.get('kind') == 'illustration':
        if set(source) != {'kind'} or not illustration_allowed(context.question):
            raise ValueError('illustration was not requested')
        if spec.get('props',{}).get('title') != 'Illustration — synthetic values': raise ValueError('illustration title')
        for output in spec.get('outputs',[]):
            if output.get('kind') == 'chart' and (output.get('title') != 'Illustration — synthetic values' or any(re.search(r'\d{4}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)',p['label'],re.I) for p in output['points'])):
                raise ValueError('illustration source/date/title denied')
    elif source.get('kind') == 'calculation':
        original = {**source, 'kind': 'provided'}
        receipt = context.checked(original)
        if spec.get('component') != 'budget-planner': raise ValueError('calculation source requires fixed budget template')
        supplied = {p['label'].lower().replace(' expenses',''):p['value'] for p in receipt['points']}
        factor = 1 if spec.get('props',{}).get('currency','UGX') == 'UGX' else 100
        if any(Decimal(str(spec.get('initial',{}).get(k))) != number(supplied.get(k))*factor for k in ('income','housing','food','other')):
            raise ValueError('budget source values differ')
    else:
        receipt = context.checked(source)
        charts = [o for o in spec.get('outputs', []) if o.get('kind') == 'chart']
        if len(charts) != 1: raise ValueError('one chart output required')
        context.check_points(source, charts[0]['points'])
        # No model-authored numerical narrative or provenance line beside the chart.
        if any(o.get('kind') != 'chart' for o in spec.get('outputs', [])): raise ValueError('model narrative beside series denied')
        if charts[0].get('title') != receipt['title'] or spec.get('props', {}).get('title') != receipt['title']: raise ValueError('unverified chart title')
    if spec.get('type') != 'widget': raise ValueError('legacy chart lacks a validated declaration')
    charts = sum(o.get('kind') == 'chart' for o in spec.get('outputs', []))
    if charts > 1: raise ValueError('one chart output required')
    return spec


def history_request(question):
    return bool(re.search(r'\b(?:past|last|historical|history|trend|monthly|months?)\b', str(question), re.I))


def source_line(source):
    if source['kind'] == 'illustration': return 'Illustration: synthetic, unmeasured values.'
    if source['tool'] == 'yahoo_chart':
        query = json.loads(source['query'])
        prefix = 'Source: Yahoo Finance; ' + query['symbol'] + '; requested: ' + query['start'] + ' to ' + query['end']
    else:
        prefix = 'Calculated from editable supplied inputs' if source['kind'] == 'calculation' else 'Source: your supplied figures'
    line = prefix + ('; recorded this turn: ' if source['kind'] in ('provided','calculation') else '; retrieved: ') + source['timestamp']
    if source['observed_through']: line += '; observations through: ' + source['observed_through']
    line += '; ' + source['aggregation']
    if source['missing']: line += '; missing: ' + ', '.join(source['missing'])
    return line


def describe(receipt):
    points = receipt['points']
    points_ok(points, supplied=receipt['source']['kind'] == 'provided')
    return receipt['title'] + '\n\n' + '\n'.join(p['label'] + ': ' + str(p['value']) for p in points) + '\n\n' + source_line(receipt['source'])


def illustration_allowed(question):
    q = str(question)
    return bool(re.search(r'\b(?:illustrat\w*|synthetic|hypothetical|made.up)\b', q, re.I)) and not re.search(r'\b(?:no|not|never|without)\b[^.!?]{0,60}\b(?:illustrat\w*|synthetic|hypothetical|made.up)\b', q, re.I)
