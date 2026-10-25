"""Harness-owned presentation. Tool results are receipts, never page events."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys
from . import store, progress
from .locks import KeyLock, root

VERSION = json.loads((Path(__file__).parent / 'version.json').read_text())['version']
UI_SCHEMA = {'name': 'emit_ui', 'description': 'Finish the answer. Prose uses kind=prose and an empty program. Interfaces use validated OpenUI without fences. One initial attempt and one repair; never print the program as final text.',
 'parameters': {'type': 'object', 'additionalProperties': False, 'properties': {
  'intro': {'type': 'string', 'maxLength': 20000}, 'program': {'type': 'string', 'maxLength': 65536},
  'kind': {'type': 'string', 'enum': ['prose','interface']},
  'required': {'type': 'array', 'items': {'type': 'string'}}}, 'required': ['intro','program','kind']}}
PROGRESS_SCHEMA = {'name': 'emit_progress', 'description': 'Report one permitted working state.',
 'parameters': {'type': 'object', 'additionalProperties': False, 'properties': {
  'state': {'type': 'string', 'enum': list(progress.STATES)}}, 'required': ['state']}}


def context():
    # Only the adapter writes this private file, under its conversation execution lock.
    path = os.environ.get('PRESENT_CONTEXT')
    if not path:
        raise ValueError('presentation_context_missing')
    ctx = json.loads(Path(path).read_bytes())
    store.key(*(ctx[k] for k in ['owner','conv','session','turn','version']))
    if ctx['version'] != VERSION:
        raise ValueError('presentation_version_mismatch')
    return ctx


def _validate(program, ctx):
    app = Path(os.environ['PRESENT_APP']).resolve()
    check = Path(__file__).with_name('openui_validate_once.py')
    run = subprocess.run([sys.executable, str(check)], input=json.dumps({'program':program,'receipts':ctx.get('receipts',[])}),
                         capture_output=True, text=True, timeout=12, cwd=app)
    if not run.stdout.strip():
        return {'ok':False,'stage':'runtime','error':'validator_no_result'}
    return json.loads(run.stdout.strip().splitlines()[-1])


def emit(args):
    ctx = context()
    keys = [ctx[k] for k in ['owner','conv','session','turn','version']]
    name = store.key(*keys)
    with KeyLock('emission', name):
        if store.get(*keys):
            raise ValueError('emit_ui_twice_for_turn')
        path = root() / ('attempts-' + name + '.json')
        try:
            attempts = json.loads(path.read_bytes())['count']
        except FileNotFoundError:
            attempts = 0
        if attempts >= 2:
            raise ValueError('presentation_attempts_exhausted')
        store.atomic(path, {'count':attempts+1})
        if not isinstance(args,dict) or set(args)-{'intro','program','kind','required'}:
            raise ValueError('invalid_emission_fields')
        intro, program, kind = (args.get(k) for k in ['intro','program','kind'])
        if not isinstance(intro,str) or len(intro)>20000 or not isinstance(program,str) or len(program.encode())>65536:
            raise ValueError('invalid_emission_size_or_type')
        if kind not in ctx['allowed_kinds']:
            raise ValueError('required_presentation_kind_missing')
        if '```openui' in intro or '\u200b' in intro:
            raise ValueError('program_must_not_be_in_intro')
        if kind == 'prose':
            if program.strip() or not intro.strip() or ctx.get('required'):
                raise ValueError('invalid_prose_envelope')
            result = {'ok':True,'components':[],'bindings':[]}
        elif kind == 'interface':
            result = _validate(program, ctx)
            if not result.get('ok'):
                return {'accepted':False,'stage':result.get('stage','validate'), 'diagnostics':[result.get('error','validation_failed')]}
            program = result.get('canonicalCode',program)
            if set(ctx.get('required',[]))-set(result.get('bindings',[])):
                raise ValueError('required_editable_bindings_missing')
        else:
            raise ValueError('invalid_presentation_kind')
        payload = dict(version=VERSION,kind=kind,intro=intro,program=program,
                       required=ctx.get('required',[]),components=result.get('components',[]),receipts=ctx.get('receipts',[]))
        rec = store.put(payload,*keys)
        return {'accepted':True,'receipt':rec['sha256'],'version':VERSION}


def handle_emit_ui(args):
    try:
        return json.dumps(emit(args))
    except (ValueError, RuntimeError, KeyError, TypeError, OSError, subprocess.SubprocessError) as exc:
        return json.dumps({'accepted':False,'stage':'emission','diagnostics':[str(exc)[:400]]})


def handle_emit_progress(args):
    try:
        if not isinstance(args,dict) or set(args)!={'state'}:
            raise ValueError('unsupported_progress_state')
        ctx=context()
        ev=progress.accept(args['state'],*(ctx[k] for k in ['owner','conv','session','turn','version']))
        return json.dumps({'ok':True,'emitted':ev is not None})
    except (ValueError, KeyError, TypeError, OSError) as exc:
        return json.dumps({'ok':False,'error':str(exc)[:200]})


def register(ctx):
    ctx.register_tool(name='emit_ui',toolset='page_presentation',schema=UI_SCHEMA,handler=handle_emit_ui,emoji='🖼️')
    ctx.register_tool(name='emit_progress',toolset='page_presentation',schema=PROGRESS_SCHEMA,handler=handle_emit_progress,emoji='…')
