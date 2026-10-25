"""Bounded access to the existing engine's two public web tools, without an agent turn.

No model-provided code or command is executed. The child receives JSON on stdin and can
dispatch only web_search_tool / web_extract_tool; the engine keeps its existing backend.
"""
import ipaddress
import functools
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import time
import urllib.parse

ROOT=Path(__file__).resolve().parent
TOOLS={'web_search','web_extract'}


@functools.lru_cache(maxsize=8)
def _checked_python(path,mtime,size):
    # A shell launcher is not a Python interpreter. Test only interpreter-named executables,
    # and require Python 3 to identify itself before passing it the helper's .py file.
    if not re.fullmatch(r'(?:python(?:3(?:\.\d+)?)?|pypy3(?:\.\d+)?)',Path(path).name):
        raise ValueError('JARVIS_LOOKUP_PYTHON must name a Python 3 interpreter')
    try:
        probe=subprocess.run([path,'-c','import sys; print("JARVIS_PYTHON_3" if sys.version_info.major == 3 else "unsupported")'],
                             capture_output=True,text=True,timeout=3)
    except (OSError,subprocess.SubprocessError):
        raise ValueError('JARVIS_LOOKUP_PYTHON could not run Python 3') from None
    if probe.returncode or probe.stdout.strip()!='JARVIS_PYTHON_3':
        raise ValueError('JARVIS_LOOKUP_PYTHON did not identify as Python 3')
    return Path(path)


def resolve_python(binary):
    engine=Path(binary).expanduser().resolve()
    explicit=os.environ.get('JARVIS_LOOKUP_PYTHON','').strip()
    if explicit:
        candidates=[Path(explicit).expanduser()]
        if not candidates[0].is_absolute():raise ValueError('JARVIS_LOOKUP_PYTHON must be an absolute path')
    else:
        candidates=[engine.with_name('python'),engine.with_name('python3')]
        first=''
        if engine.is_file():
            with engine.open() as handle:first=handle.readline(1024).strip()
        # Only a direct absolute Python shebang is eligible. Do not interpret shell syntax,
        # follow exec statements, or guess a system interpreter that lacks the engine packages.
        if first.startswith('#!') and ' ' not in first[2:] and Path(first[2:]).is_absolute():
            candidates.append(Path(first[2:]))
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate,os.X_OK):
            try:
                stat=candidate.stat()
                return _checked_python(str(candidate),stat.st_mtime_ns,stat.st_size)
            except ValueError:
                if explicit:raise
    raise ValueError('Set JARVIS_LOOKUP_PYTHON to the staging engine virtualenv Python; launcher interpreter is not Python')


def public_url(value):
    if not isinstance(value,str) or len(value)>2048: raise ValueError('invalid public URL')
    url=urllib.parse.urlsplit(value)
    if url.scheme!='https' or not url.hostname or url.username or url.password or url.port not in (None,443):
        raise ValueError('public HTTPS URLs only')
    addresses=socket.getaddrinfo(url.hostname,443,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('private network access is unavailable here')
    return value


def arguments(name,args):
    if name not in TOOLS or not isinstance(args,dict):raise ValueError('unknown read tool')
    if name=='web_search':
        if set(args)!={'query'} or not isinstance(args['query'],str) or not 2<=len(args['query'])<=600:
            raise ValueError('invalid search query')
    elif set(args)!={'urls'} or not isinstance(args['urls'],list) or not 1<=len(args['urls'])<=2:
        raise ValueError('invalid page request')
    else:
        for value in args['urls']: public_url(value)
    return args


def run(binary,name,args,stop=None):
    arguments(name,args)
    # Resolve the already-configured engine executable, not a path chosen by the model.
    engine=Path(binary).expanduser().resolve()
    python=resolve_python(binary)
    env=dict(os.environ)
    env.update(WEB_TOOLS_DEBUG='false',OPENUI_TELEMETRY_DISABLED='1',DO_NOT_TRACK='1')
    proc=subprocess.Popen([str(python),str(ROOT/'tools/presentation_lookup.py')],stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=str(engine.parent),env=env,text=True)
    payload=json.dumps({'tool':name,'arguments':args});started=time.monotonic()
    try:
        while True:
            if stop and stop():raise ValueError('read cancelled')
            if time.monotonic()-started>22:raise ValueError('public lookup timed out')
            try:
                output,_=proc.communicate(input=payload,timeout=.2);break
            except subprocess.TimeoutExpired:payload=None
        if proc.returncode or len(output.encode())>65536:raise ValueError('public lookup unavailable')
        marker='JARVIS_READ_RESULT='
        line=next((line[len(marker):] for line in reversed(output.splitlines()) if line.startswith(marker)),None)
        if line is None:raise ValueError('public lookup unavailable')
        result=json.loads(line)
        if not isinstance(result,dict) or not result.get('ok'):raise ValueError('public lookup unavailable')
        return result['data']
    finally:
        if proc.poll() is None:proc.kill()
        proc.communicate()
