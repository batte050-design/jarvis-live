"""Compile real production symbols without importing/startup, credentials or service dependencies."""
import ast
import asyncio
import contextlib
import copy
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import re
import secrets
import signal
import subprocess
import threading
import time
from types import SimpleNamespace
import urllib
import urllib.parse
import urllib.request
import uuid


class Response:
    def __init__(self, content=None, status_code=200, **kwargs):
        self.content, self.status_code = content, status_code
        self.__dict__.update(kwargs)


def symbols(root, names, extra=None, nested=None):
    root = Path(root)
    env = {name: value for name, value in globals().items() if not name.startswith('_')}
    env.update(Request=object, JSONResponse=Response, StreamingResponse=Response)
    env.update(extra or {})
    tree = ast.parse((root/'server.py').read_text())
    pool = tree.body if nested is None else list(ast.walk(next(n for n in tree.body if getattr(n, 'name', '') == nested)))
    chosen = []
    for name in names:
        node = copy.deepcopy(next(n for n in pool if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == name))
        node.decorator_list = []
        chosen.append(node)
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)]+chosen, type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module, str(root/'server.py'), 'exec'), env)
    return env


def module(root, name):
    spec = importlib.util.spec_from_file_location('_test_'+name, Path(root)/(name+'.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def assignments(root, names):
    tree = ast.parse((Path(root)/'server.py').read_text())
    env = {'re': re, 'os': os}
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in node.targets):
            exec(compile(ast.Module(body=[node], type_ignores=[]), '<actual constants>', 'exec'), env)
    return {n: env[n] for n in names}


def agent_environment(root, home, binary):
    WarmAgent = module(root, "warm_agent").WarmAgent
    home = Path(home)
    (home/'logs').mkdir(exist_ok=True)
    env = dict(HERE=str(home), WORKDIR=str(home), HERMES_BIN=str(binary),
               WARM_PRESTART=threading.local(), WARM_AGENTS={}, WARM_FAILURES={}, WARM_BUILDING=set(), WARM_LOCK=threading.Lock(),
               WARM_BUILD_LOCK=threading.Lock(), WarmAgent=WarmAgent, WARM_ENABLED=True,
               WARM_IDLE_SECONDS=1800, WARM_BUILD_TIMEOUT=5, WARM_READY_WAIT=2,
               AGENT_TIMEOUT=5, AGENT_RUN_BUDGET=5, FALLBACK_COUNT=[0], SESSION={'id':''}, EPOCH=[0],
               config_model=lambda:'test-model', route_format=lambda q:'prose', UI_NOTE='', NO_FILLER='', NO_VOICE_LOSS='', _guard_path=lambda *a:None,
               mark_agent_seen=lambda *a:None, approval_lock=threading.RLock,
               APPROVAL_SECRETS={}, AUTO_ENABLED=False, PORT=49151,
               WEB_NOTE='SEARCH FIRST. ', NO_MEMORY_NOTE='NO MEMORY. ',
               format_directive=lambda *a:'TEXT FORMAT. ', UI_LIBRARY='',
               thread_note=lambda c:'THREAD '+str(c)+'\n',
               tool_line=lambda *a:'tool', tool_title=lambda *a:'Tool', tool_detail=str,
               strip_delivery=str, spoken_from_output=lambda text,screen=False:(text.split('<<<SPOKEN',1)[-1].split('SPOKEN>>>',1)[0].strip(), '<<<SPOKEN' in text))
    env['_redact'] = SimpleNamespace(redact=str)
    names=['agent_session_name','write_turn_ctx','warm_agent','_warm_build','warm_prewarm_for',
           'warm_prewarm','_warm_events','warm_build_in_background','warm_answer','hermes_answer']
    return symbols(root,names,env)
