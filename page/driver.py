"""Actual warm-ACP transport with mandatory installed-harness profile/load hooks.

No guessed ACP extension is sent. The deployment's session factory must implement
its real frozen-prefix and session/load APIs. Missing hooks fail before generation.
"""
import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from .warm_agent import WarmAgent
from .plugin import progress, store
from .plugin.locks import root, digest


class ACPDriver:
    def __init__(self, binary, workdir, session_factory, permission_action, *, child_env=None, timeout=480):
        if not callable(session_factory) or not callable(permission_action):
            raise ValueError('installed_harness_hooks_required')
        self.binary,self.workdir=binary,workdir
        self.session_factory,self.permission_action=session_factory,permission_action
        self.child_env,self.timeout=child_env or {},timeout
        self.agents={}
        self.cache_lock=threading.RLock()

    def open(self,spec,previous):
        with self.cache_lock:
            return self._open(spec,previous)

    def _open(self,spec,previous):
        name=digest([spec['owner'],spec['conv'],spec['version']])
        active={'permission':None,'stop':None}
        def permission(params):
            if not active['permission']:return None
            # Obtain exact args from the installed ACP implementation, never its title/text.
            binding=json.loads(Path(context_path).read_bytes())
            action=self.permission_action(params,binding)
            options=params.get('options') or []
            once=next((o.get('optionId') or o.get('option_id') for o in options
                       if isinstance(o,dict) and (o.get('kind')=='allow_once' or o.get('optionId')=='allow_once')),None)
            if not once:raise ValueError('approval_has_no_once_option')
            return once if active['permission'](action) else None
        context_path=str(root()/'contexts'/(name+'.json'))
        profile_path=root()/'profiles'/(name+'.json')
        store.atomic(profile_path,{**{k:spec[k] for k in ['owner','conv','version','prefix_sha256']},'prefix':spec['prefix'].decode('utf-8')})
        agent=self.agents.get(name)
        if agent is None:
            if len(self.agents)>=2:
                idle=[(k,a) for k,a in self.agents.items() if not a.busy()]
                if not idle:raise RuntimeError("page_harness_capacity_busy")
                old,child=max(idle,key=lambda pair:pair[1].idle_for())
                child.close();self.agents.pop(old)
            expected_session=[previous['session'] if previous else None]
            saved=[previous]
            def factory(client):
                result=self.session_factory(client,spec,saved[0])
                expected=expected_session[0]
                sid=result.get('sessionId') or result.get('session_id')
                if not sid or expected and sid!=expected or result.get('prefix_sha256')!=spec['prefix_sha256'] or result.get('version')!=spec['version']:
                    raise ValueError('harness_profile_or_resume_not_attested')
                expected_session[0]=sid
                saved[0]={**result,'session':sid}
                return result
            agent=WarmAgent(self.binary,self.workdir,name,timeout=self.timeout,ctx_path=None,
                            child_env={**self.child_env,'JARVIS_AUTO_APPROVE_ENABLED':'0','PRESENT_STORE':str(root()),'PRESENT_APP':self.workdir,'PRESENT_CONTEXT':context_path,'PRESENT_PROFILE':str(profile_path)},
                            session_factory=factory,permission_handler=permission,presentation_mode=True)
            agent._page_active=active
            self.agents[name]=agent
        if not agent.ensure_ready():raise RuntimeError('harness_session_start_failed')
        meta=agent.session_metadata
        session={**{k:meta[k] for k in ['system_prefix_sha256','tools_sha256','completion_required'] if k in meta},'session':agent._session_id,'version':meta['version'],'prefix_sha256':meta['prefix_sha256'],'driver_key':name}
        return session

    def run(self,session,question,context_path,event,permission,stop):
        agent=self.agents[session['driver_key']]
        active=agent._page_active;active.update(permission=permission,stop=stop)
        ctx=json.loads(Path(context_path).read_bytes())
        key=store.key(*(ctx[k] for k in ['owner','conv','session','turn','version']))
        seen=[None]
        def update(kind,data):
            # The page shows what the harness is doing. Forward only the call id, its lifecycle
            # status and the operation name: never arguments, output, reasoning or free text.
            if kind in ('tool_use','tool_result'):
                d=data if isinstance(data,dict) else {}
                op=str(d.get('name') or d.get('tool') or '')
                call_id=str(d.get('id') or d.get('call_id') or d.get('tool_call_id') or '')
                event('tool_step',{'op':op,'call_id':call_id,
                                   'status':'running' if kind=='tool_use' else 'done'})
                if kind=='tool_result':
                    marker=root()/('progress-'+key+'.json')
                    if marker.exists():
                        ev=json.loads(marker.read_bytes())
                        if ev['ts']!=seen[0]:
                            seen[0]=ev['ts'];event('stored_progress',ev)
            # Assistant text, reasoning and tool payloads are deliberately discarded.
        try:
            turn_prompt=[{"type":"text","text":question},
                         {"type":"text","text":"<page_turn_context>Current UTC: "+datetime.now(timezone.utc).isoformat()+". This is runtime context, not supplied calculation data.</page_turn_context>"}]
            status,_=agent.ask(turn_prompt,on_event=update,stop=stop,retry=False)
            if agent._session_id!=session['session']:return 'failed'
            if session.get('completion_required'):
                done=(agent.last_completion.get('_meta') or {}).get('jarvis_page') or {}
                accepted=store.get(*(ctx[k] for k in ['owner','conv','session','turn','version']))
                if done.get('session')!=session['session'] or done.get('turn')!=ctx['turn'] or done.get('ok') is not True or not accepted or done.get('payload_sha256')!=accepted['sha256']:
                    return 'failed'
            return status
        finally:
            active.update(permission=None,stop=None)
