"""Bounded, read-only Wikimedia photograph search with attribution. No model-chosen URLs."""
import datetime as dt
from html import unescape
from html.parser import HTMLParser
import json
import re
import threading
import time
import urllib.parse
import urllib.request

_CACHE = {}; _LOCK = threading.Lock()


class Plain(HTMLParser):
    def __init__(self, text):
        super().__init__(); self.words=[]; self.feed(str(text))
    def handle_data(self, data): self.words.append(data)
    def text(self): return re.sub(r'\s+',' ',unescape(''.join(self.words))).strip()[:300]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): raise ValueError('image redirect refused')


def fetch(params):
    url='https://commons.wikimedia.org/w/api.php?'+urllib.parse.urlencode({'action':'query','format':'json','formatversion':'2',**params})
    request=urllib.request.Request(url,headers={'User-Agent':'JarvisLive-ImageReview/1 (https://github.com/batte050-design/jarvis-live)','Accept':'application/json'})
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=8) as response:
        data=response.read(768*1024+1)
    if len(data)>768*1024: raise ValueError('image search too large')
    result=json.loads(data)
    if result.get('error'): raise ValueError('image search unavailable')
    return result


def search(query, fetcher=None):
    query=re.sub(r'\s+',' ',str(query)).strip()
    if not 2<=len(query)<=200 or re.search(r'[\x00-\x1f]',query): raise ValueError('image query length')
    now=time.monotonic()
    with _LOCK:
        cached=_CACHE.get(query)
        if cached and cached[0]>now and fetcher is None: return cached[1]
    result=(fetcher or fetch)({'generator':'search','gsrsearch':query+' filetype:bitmap','gsrnamespace':'6','gsrlimit':'6',
                             'prop':'imageinfo','iiprop':'url|mime|extmetadata','iiurlwidth':'960'})
    photos=[]; stamp=dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
    for page in sorted(result.get('query',{}).get('pages',[]),key=lambda p:p.get('index',0)):
        if not isinstance(page,dict): continue
        infos=page.get('imageinfo') or []
        if not infos or not isinstance(infos[0],dict): continue
        info=infos[0];url=info.get('thumburl') or info.get('url','');title=page.get('title','').removeprefix('File:')
        parsed=urllib.parse.urlsplit(url)
        if parsed.scheme!='https' or parsed.hostname not in ('upload.wikimedia.org','thumb.wikimedia.org') or parsed.port not in (None,443) or parsed.username or parsed.password: continue
        if info.get('mime') not in ('image/jpeg','image/png','image/webp') or re.search(r'\b(?:logo|icon|map|flag|diagram)\b',title,re.I): continue
        meta=info.get('extmetadata') or {}
        def value(key): return Plain((meta.get(key) or {}).get('value','')).text()
        license=value('LicenseShortName'); license_url=value('LicenseUrl')
        if not license or not license_url.startswith(('https://creativecommons.org/','http://creativecommons.org/')): continue
        photos.append({'url':parsed._replace(query='',fragment='').geturl(),'title':title[:250],'page':'https://commons.wikimedia.org/wiki/File:'+urllib.parse.quote(title.replace(' ','_')),
                       'author':value('Artist') or value('Credit') or 'Wikimedia contributor','license':license,
                       'licenseUrl':license_url.replace('http:','https:',1),'retrieved':stamp})
    photos=photos[:4]
    if photos and fetcher is None:
        with _LOCK:
            if len(_CACHE)>=128: _CACHE.pop(next(iter(_CACHE)))
            _CACHE[query]=(now+3600,photos)
    return photos
