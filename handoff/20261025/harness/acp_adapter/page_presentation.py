"""Frozen page profile for the installed ACP adapter; standard-library only.

Loaded only in a dedicated page child with PRESENT_PROFILE set. Other ACP clients
keep their existing prompt, tools, persistence and permission behavior.
"""
from __future__ import annotations
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import types


def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()


def sha(value):return hashlib.sha256(value).hexdigest()


def atomic(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.profile-')
    try:
        with os.fdopen(fd,'wb') as f:f.write(canonical(value));f.flush();os.fsync(f.fileno())
        os.replace(tmp,path)
        fd=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)


def profile():
    filename=os.environ.get('PRESENT_PROFILE')
    if not filename:return None
    value=json.loads(Path(filename).read_bytes())
    for k in ['owner','conv','version','prefix','prefix_sha256']:
        if not isinstance(value.get(k),str) or not value[k]:raise ValueError('invalid_page_profile')
    if sha(value['prefix'].encode())!=value['prefix_sha256']:raise ValueError('page_profile_hash_mismatch')
    return value


def tools_hash(agent):return sha(canonical(agent.tools))


def ensure_page_tools(agent):
    """Expose the registered emit tools directly, only for a bound page child.

    Plugin catalog selection/progressive disclosure is not the terminal emission
    contract. Keep the existing agent tools and registry dispatch unchanged.
    """
    if not os.environ.get('PRESENT_PROFILE'):
        return
    required={'emit_ui','emit_progress'}
    tools=list(agent.tools or [])
    present={t['function']['name'] for t in tools}
    missing=required-present
    if not missing:
        return
    disabled=set(getattr(agent,'disabled_toolsets',None) or [])
    if disabled & {'page_presentation','all','*'}:
        raise ValueError('page_presentation_explicitly_disabled')
    from model_tools import registry
    definitions=registry.get_definitions(required,quiet=True)
    registered={t['function']['name']:t for t in definitions}
    unavailable=required-registered.keys()
    if unavailable:
        raise ValueError('page_presentation_registry_missing:'+','.join(sorted(unavailable)))
    # Do not substitute handwritten schemas: use the definitions whose handlers
    # are registered in this child/profile. No other tool or surface is changed.
    additions=[copy.deepcopy(registered[name]) for name in sorted(missing)]
    agent.tools=tools+additions
    agent.valid_tool_names={t['function']['name'] for t in agent.tools}


def attach(agent,session_id,*,restoring=False,expected=None):
    p=profile()
    if p is None:
        if expected:raise ValueError('page_session_requires_bound_profile')
        return agent
    ensure_page_tools(agent)
    binding={k:p[k] for k in ['owner','conv','version','prefix_sha256']}
    binding['session']=session_id
    if expected and any(expected.get(k)!=v for k,v in binding.items()):raise ValueError('page_session_binding_mismatch')
    path=Path(os.environ['PRESENT_STORE'])/'harness-prefixes'/(sha(session_id.encode())+'.json')
    saved=json.loads(path.read_bytes()) if path.exists() else None
    if saved and any(saved.get(k)!=v for k,v in binding.items()):raise ValueError('page_session_binding_mismatch')
    if restoring and not saved:raise ValueError('page_frozen_prefix_missing')
    builder=getattr(agent,'_build_system_prompt',None)
    if not callable(builder):raise ValueError('page_system_prompt_builder_missing')
    agent._page_binding=dict(binding)
    agent._page_frozen=saved
    agent._page_completion=None
    def frozen(self,*args,**kwargs):
        record=self._page_frozen
        ensure_page_tools(self)
        current=tools_hash(self)
        if record:
            if record['tools_sha256']!=current:raise ValueError('page_tools_changed_requires_new_session')
            if sha(record['system_prefix'].encode())!=record['system_prefix_sha256']:raise ValueError('page_system_prefix_corrupt')
        else:
            names={t['function']['name'] for t in self.tools}
            if not {'emit_ui','emit_progress'}.issubset(names):raise ValueError('page_presentation_tools_not_registered')
            base=builder(*args,**kwargs)
            if not isinstance(base,str):raise ValueError('page_system_prompt_not_text')
            full=base+'\n\n<page_presentation version="'+p['version']+'">\n'+p['prefix']+'\n</page_presentation>'
            record={**binding,'tools_sha256':current,'system_prefix':full,'system_prefix_sha256':sha(full.encode())}
            atomic(path,record)
            self._page_frozen=record
        # Existing AIAgent builds may use this cache after the method returns.
        if hasattr(self,'_cached_system_prompt'):self._cached_system_prompt=record['system_prefix']
        return record['system_prefix']
    agent._build_system_prompt=types.MethodType(frozen,agent)
    return agent


def attest(state):
    agent=state.agent
    if not getattr(agent,'_page_binding',None):return None
    agent._build_system_prompt()
    return {**agent._page_binding,'system_prefix_sha256':agent._page_frozen['system_prefix_sha256'],
            'tools_sha256':agent._page_frozen['tools_sha256']}


def context(state):
    value=json.loads(Path(os.environ['PRESENT_CONTEXT']).read_bytes())
    binding=attest(state)
    if not binding or any(value.get(k)!=binding[k] for k in ['owner','conv','version','session']):
        raise ValueError('page_turn_context_mismatch')
    if not isinstance(value.get('turn'),str) or not value['turn']:raise ValueError('page_turn_missing')
    return value


def begin(state):
    if getattr(state.agent,'_page_binding',None):
        ctx=context(state)
        state.agent._page_completion={'session':state.session_id,'turn':ctx['turn'],'ok':False}


def complete(state,result):
    if not getattr(state.agent,'_page_binding',None):return None
    ctx=context(state)
    ok=isinstance(result,dict) and not any(result.get(k) for k in ['error','api_error','interrupted','cancelled','failed'])
    ok=ok and not (state.cancel_event and state.cancel_event.is_set())
    keys=[ctx[k] for k in ['owner','conv','session','turn','version']]
    path=Path(os.environ['PRESENT_STORE'])/(sha(json.dumps(keys,separators=(',',':'),ensure_ascii=False).encode())+'.json')
    record=json.loads(path.read_bytes()) if path.exists() else None
    if record:
        ok=ok and all(record.get(k)==ctx[k] for k in ['owner','conv','session','turn','version'])
        ok=ok and sha(canonical(record['payload']))==record.get('sha256')
    else:ok=False
    value={'session':state.session_id,'turn':ctx['turn'],'ok':bool(ok),
           'payload_sha256':record.get('sha256') if ok else None}
    state.agent._page_completion=value
    return value


def completion(state):return getattr(state.agent,'_page_completion',None)


def permission_binding(state,tool_ids,tool_meta,requested_id=None):
    ctx=context(state)
    pending=[(name,tid,tool_meta[tid]) for name,ids in tool_ids.items() for tid in ids if tid in tool_meta]
    if requested_id and any(tid==requested_id for _,tid,_ in pending):
        pending=[item for item in pending if item[1]==requested_id]
    # Do not guess which operation a synthetic permission bubble refers to.
    if len(pending)!=1:raise ValueError('page_permission_binding_ambiguous')
    name,tid,meta=pending[0]
    args=json.loads(canonical(meta['args']))
    return {'session':state.session_id,'turn':ctx['turn'],'operation':name,'tool_call_id':tid,
            'arguments':args,'arguments_sha256':sha(canonical(args))}


def permission_request(conn,state,tool_ids,tool_meta):
    async def request(*args,**kwargs):
        call=kwargs.get('tool_call') or (args[1] if len(args)>1 else None)
        requested_id=(call.get('toolCallId') or call.get('tool_call_id')) if isinstance(call,dict) else getattr(call,'tool_call_id',None)
        bound=permission_binding(state,tool_ids,tool_meta,requested_id)
        extra=dict(kwargs.pop('field_meta',None) or {})
        extra['jarvis_page']=bound
        return await conn.request_permission(*args,**kwargs,field_meta=extra)
    return request
