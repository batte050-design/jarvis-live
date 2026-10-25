"""Hooks for the supplied installed ACP adapter, with server-attested bindings."""
import hashlib
import json
from pathlib import Path
from .adapter import Profile
from .plugin import VERSION, UI_SCHEMA, PROGRESS_SCHEMA
from .plugin.store import canonical


def display_profile(library_prompt):
    if not isinstance(library_prompt,str) or not library_prompt.strip():raise ValueError('display_contract_missing')
    prompt=Path(__file__).with_name('plugin').joinpath('prompt.txt').read_text()
    schemas=json.dumps([UI_SCHEMA,PROGRESS_SCHEMA],sort_keys=True,separators=(',',':'),ensure_ascii=False)
    # The harness supplies persona/policy/tools. This section adds only page instructions.
    return Profile((prompt+'\n'+schemas+'\n'+library_prompt).encode(),VERSION)


def session_factory(client,spec,previous):
    if previous:
        expected=previous['session']
        result=client._request('session/load',{'sessionId':expected,'cwd':client.workdir,'mcpServers':[]})
    else:
        expected=None
        result=client._request('session/new',{'cwd':client.workdir,'mcpServers':[]})
    meta=(result.get('_meta') or {}).get('jarvis_page')
    if not isinstance(meta,dict):raise ValueError('harness_page_attestation_missing')
    for key in ['owner','conv','version','prefix_sha256']:
        if meta.get(key)!=spec[key]:raise ValueError('harness_page_attestation_mismatch')
    sid=meta.get('session')
    if not sid or expected and sid!=expected:raise ValueError('harness_loaded_wrong_session')
    if not previous and result.get('sessionId')!=sid:raise ValueError('harness_created_wrong_session')
    for key in ['system_prefix_sha256','tools_sha256']:
        if not isinstance(meta.get(key),str) or len(meta[key])!=64:raise ValueError('harness_prefix_attestation_invalid')
        if previous and previous.get(key)!=meta[key]:raise ValueError('harness_frozen_prefix_changed')
    return {'sessionId':sid,**meta,'completion_required':True}


def permission_action(params,binding):
    if params.get('sessionId',binding['session'])!=binding['session']:raise ValueError('permission_session_mismatch')
    meta=(params.get('_meta') or {}).get('jarvis_page')
    if not isinstance(meta,dict) or meta.get('session')!=binding['session'] or meta.get('turn')!=binding['turn']:
        raise ValueError('permission_turn_binding_missing')
    arguments=meta.get('arguments')
    if not isinstance(arguments,dict) or hashlib.sha256(canonical(arguments)).hexdigest()!=meta.get('arguments_sha256'):
        raise ValueError('permission_arguments_not_bound')
    operation=meta.get('operation')
    if not isinstance(operation,str) or not operation:raise ValueError('permission_operation_missing')
    # Display text is not used to infer authority. The exact pending operation stays private.
    call=params.get('toolCall') or {}
    title=call.get('title') or operation
    return {'operation':operation,'target':str(title)[:240], 'reason':'This action requires your approval.',
            'effect':'Allow this exact pending action once.',
            'arguments':{'tool_call_id':meta['tool_call_id'],'operation':operation,'input':arguments}}
