"""Durable page-turn coordinator. No provider client, no model-text delivery.

The injected Driver must create/load REAL harness sessions with a frozen profile.
A scripted driver is useful for local tests but is never live-model evidence.
"""
from __future__ import annotations
from dataclasses import dataclass
import hashlib
import json
import logging
from pathlib import Path
import threading
import time
import uuid
from .plugin import VERSION
from .plugin import approvals, store, progress
from .plugin.locks import root, digest, KeyLock

LOG = logging.getLogger(__name__)


@dataclass(frozen=True)
class Profile:
    prefix: bytes
    version: str = VERSION

    @property
    def sha256(self):
        return hashlib.sha256(self.prefix).hexdigest()


class Adapter:
    def __init__(self, driver, profile, *, timeout=480):
        self.driver, self.profile, self.timeout = driver, profile, timeout
        if profile.version != VERSION or not profile.prefix:
            raise ValueError('invalid_frozen_profile')
        self.workers = set()
        self.guard = threading.Lock()

    def _path(self, owner, conv, turn):
        store.key(owner,conv,'page',turn,self.profile.version)
        return root() / 'turns' / (digest([owner,conv,turn])+'.json')

    def read(self, owner, conv, turn):
        return json.loads(self._path(owner,conv,turn).read_bytes())

    def _update(self, owner, conv, turn, fn):
        with KeyLock('turn',digest([owner,conv,turn])):
            path=self._path(owner,conv,turn)
            row=json.loads(path.read_bytes())
            fn(row)
            store.atomic(path,row)
            return row

    def start(self, owner, conv, turn, question, *, required=(), allowed_kinds=('prose','interface'), receipts=()):
        if not isinstance(question,str) or not question.strip() or len(question)>32000:
            raise ValueError('invalid_question')
        if not set(allowed_kinds) or set(allowed_kinds)-{'prose','interface'}:
            raise ValueError('invalid_contract')
        if any(not isinstance(s,str) or not s for s in required):
            raise ValueError('invalid_required_bindings')
        request=dict(question=question,required=list(required),allowed_kinds=list(allowed_kinds),receipts=list(receipts))
        fingerprint=hashlib.sha256(store.canonical(request)).hexdigest()
        path=self._path(owner,conv,turn)
        with KeyLock('turn',digest([owner,conv,turn])):
            if path.exists():
                row=json.loads(path.read_bytes())
                if row['request_sha256']!=fingerprint:
                    raise ValueError('turn_id_reused_with_different_request')
                # Do not restart work on a browser retry, even on another web worker.
                return self.public(row)
            row=dict(owner=owner,conv=conv,turn=turn,version=self.profile.version,
                     prefix_sha256=self.profile.sha256,request=request,request_sha256=fingerprint,
                     status='queued',created_at=time.time(),cancelled=False,terminal=None,current_progress=None,
                     approval=None,session=None,timing={'first_progress_ms':None,'first_content_ms':None,'complete_ms':None})
            store.atomic(path,row,exclusive=True)
        worker=threading.Thread(target=self._execute,args=(owner,conv,turn),daemon=True)
        with self.guard:self.workers.add(worker)
        try:
            worker.start()
        except Exception:
            with self.guard:self.workers.discard(worker)
            self._finish(owner,conv,turn,code='adapter_worker_start_failed')
            return self.snapshot(owner,conv,turn)
        return self.public(row)

    @staticmethod
    def public(row):
        return {k:row.get(k) for k in ['conv','turn','status','version','session','terminal','current_progress','approval','timing']}

    def snapshot(self,owner,conv,turn):
        return self.public(self.read(owner,conv,turn))

    def cancel(self,owner,conv,turn):
        def change(row):
            if not row['terminal']:row['cancelled']=True
        self._update(owner,conv,turn,change)

    def decide(self,owner,conv,turn,aid,decision):
        row=self.read(owner,conv,turn)
        if row['terminal'] or not row['approval'] or row['approval']['id']!=aid:
            raise ValueError('approval_not_pending_in_turn')
        return approvals.decide(aid,decision,owner,conv)

    def _finish(self,owner,conv,turn,*,payload=None,record=None,code=None):
        def finish(row):
            if row['terminal']:return
            elapsed=round((time.time()-row['created_at'])*1000)
            if row['cancelled']:code_local='turn_cancelled'
            else:code_local=code
            if code_local:
                error_id=uuid.uuid4().hex
                terminal=dict(event='failure',id=turn+':terminal',conv=conv,turn=turn,
                              status='cancelled' if row['cancelled'] else 'failed',error_id=error_id,
                              message='The request was cancelled.' if row['cancelled'] else 'JARVIS could not complete this request. Reference: '+error_id)
                LOG.error('page turn failed error_id=%s code=%s turn=%s',error_id,code_local,turn)
                row['status']=terminal['status']
            else:
                terminal=dict(event='presentation',id=turn+':terminal',conv=conv,turn=turn,
                              payload=payload,payload_sha256=record['sha256'],session=row['session'],version=row['version'])
                row['status']='ok'
                row['timing']['first_content_ms']=elapsed
            row['terminal']=terminal
            row['current_progress']=row['approval']=None
            row['timing']['complete_ms']=elapsed
        self._update(owner,conv,turn,finish)

    def _session(self,owner,conv):
        name=digest([owner,conv,self.profile.version])
        path=root()/'sessions'/(name+'.json')
        previous=json.loads(path.read_bytes()) if path.exists() else None
        if previous and previous['prefix_sha256']!=self.profile.sha256:
            raise ValueError('profile_changed_without_version_change')
        spec=dict(owner=owner,conv=conv,version=self.profile.version,prefix=self.profile.prefix,prefix_sha256=self.profile.sha256)
        session=self.driver.open(spec,previous)
        if not isinstance(session,dict) or not session.get('session') or session.get('prefix_sha256')!=self.profile.sha256 or session.get('version')!=self.profile.version:
            raise ValueError('harness_profile_not_attested')
        if previous and session['session']!=previous['session']:
            raise ValueError('harness_session_resume_mismatch')
        store.atomic(path,session)
        return session

    def prewarm(self,owner,conv):
        store.key(owner,conv,'prewarm','prewarm',self.profile.version)
        with KeyLock('conversation',digest([owner,conv]),timeout=self.timeout):
            return self._session(owner,conv)

    def _execute(self,owner,conv,turn):
        try:
            # Same conversation is serialized even across version changes and web processes.
            with KeyLock('conversation',digest([owner,conv]),timeout=self.timeout):
                row=self.read(owner,conv,turn)
                if row['terminal']:return
                if row['cancelled']:
                    self._finish(owner,conv,turn,code='turn_cancelled');return
                name=digest([owner,conv,row['version']])
                session=self._session(owner,conv)
                ctx=dict(owner=owner,conv=conv,session=session['session'],turn=turn,version=row['version'],
                         required=row['request']['required'],allowed_kinds=row['request']['allowed_kinds'],receipts=row['request']['receipts'])
                context_path=root()/'contexts'/(name+'.json')
                store.atomic(context_path,ctx)
                def running(r):r.update(status='running',session=session['session'])
                self._update(owner,conv,turn,running)
                deadline=time.monotonic()+self.timeout
                denied=[False]
                def stop():return self.read(owner,conv,turn)['cancelled'] or time.monotonic()>=deadline
                def event(kind,data):
                    # Never forward a raw tool name, arguments, output, text or reasoning.
                    if not isinstance(data,dict):return
                    if kind in ('tool_step','tool_call','step'):
                        # The reader audited the steps before; a harness turn must show the same
                        # kind of line. Map the tool to a readable action, never the raw name,
                        # arguments or output.
                        tool=str(data.get('tool') or data.get('name') or '').lower()
                        if 'browser' in tool or 'web' in tool or 'search' in tool: state,label='reading_source','Searching the web'
                        elif 'file' in tool or 'read' in tool or 'pdf' in tool: state,label='gathering_file','Reading the source'
                        elif 'calc' in tool or 'python' in tool or 'code' in tool or 'exec' in tool: state,label='computing','Working out the numbers'
                        elif 'image' in tool or 'photo' in tool: state,label='checking_figures','Finding pictures'
                        else: state,label='drafting','Putting it together'
                        ev=progress.accept(state,owner,conv,session['session'],turn,row['version'])
                        if ev: ev=dict(ev,label=label)
                    elif kind=='progress':
                        ev=progress.accept(data.get('state'),owner,conv,session['session'],turn,row['version'])
                    elif kind=='stored_progress':
                        marker=root()/('progress-'+store.key(owner,conv,session['session'],turn,row['version'])+'.json')
                        ev=json.loads(marker.read_bytes())
                        if ev.get('turn_id')!=turn or ev.get('state') not in progress.STATES:return
                    else:return
                    if not ev:return
                    def update(r):
                        if r['terminal']:return
                        r['current_progress']=ev
                        if r['timing']['first_progress_ms'] is None:r['timing']['first_progress_ms']=round((time.time()-r['created_at'])*1000)
                    self._update(owner,conv,turn,update)
                def permission(action):
                    # Driver supplies the authoritative operation and immutable exact arguments.
                    action=json.loads(store.canonical(action))
                    public=approvals.create(owner,conv,session['session'],turn,
                         *(action[k] for k in ['operation','target','reason','effect','arguments']))
                    self._update(owner,conv,turn,lambda r:r.update(approval=public,status='approval_pending'))
                    while not stop():
                        decision=approvals.resolution(public['id'],owner,conv,session['session'],turn)
                        if decision:
                            self._update(owner,conv,turn,lambda r:r.update(approval=None,status='running'))
                            denied[0]=decision!='approve_once'
                            return decision=='approve_once'
                        time.sleep(.05)
                    return False
                result=self.driver.run(session,row['request']['question'],str(context_path),event,permission,stop)
                if stop() or denied[0] or result!='ok':
                    self._finish(owner,conv,turn,code='approval_denied' if denied[0] else 'harness_'+str(result));return
                rec=store.get(owner,conv,session['session'],turn,row['version'])
                if not rec:raise ValueError('harness_completed_without_presentation')
                payload=rec['payload']
                if payload['kind'] not in ctx['allowed_kinds'] or set(ctx['required'])-set(payload.get('required',[])):
                    raise ValueError('presentation_contract_mismatch')
                self._finish(owner,conv,turn,payload=payload,record=rec)
        except Exception as exc:
            LOG.exception('private page adapter failure turn=%s',turn)
            self._finish(owner,conv,turn,code=type(exc).__name__)
        finally:
            with self.guard:self.workers.discard(threading.current_thread())

    def recover_interrupted(self):
        """Call during exclusive adapter startup, before serving requests.

        Never rerun an uncertain tool action after a crash. Completed terminal records replay.
        """
        for path in (root()/'turns').glob('*.json'):
            row=json.loads(path.read_bytes())
            if not row['terminal']:
                try:
                    with KeyLock('conversation',digest([row['owner'],row['conv']]),timeout=0):
                        self._finish(row['owner'],row['conv'],row['turn'],code='adapter_restarted_during_turn')
                except TimeoutError:
                    pass  # Another live worker owns this conversation.
