"""Exercise actual stream settings statements and nested run(), with provider/CLI boundaries recorded.
This is deterministic decision coverage; no live search/provider success is claimed.
"""
import ast
import copy
import json
from pathlib import Path
import queue
import re
import threading
import time
from types import SimpleNamespace as NS
from turn_test_support import assignments, symbols, Response


def drive(root,home,row,agent_impl=None):
    root,home=Path(root),Path(home);home.mkdir(exist_ok=True)
    conv='a'*32;payload={'conv':(' '+conv+' ') if row.get('spaced_conv') else conv}
    (home/'chat_settings.json').write_text(json.dumps({conv:{'web':row.get('stored_web',row['web']),'memory':row['memory'],'response':{'interactive':True}}}))
    # A previous, unrelated web turn must never certify the current Always turn.
    previous={'conv':'b'*32,'started':time.time(),'steps':['web_search']} if row['web_behavior']=='provider-never-searches' else {'conv':'b'*32,'started':time.time(),'steps':[]}
    (home/'executions.jsonl').write_text(json.dumps(previous)+'\n')
    state={'front':[],'agent':[],'events':[],'stored':[],'finished':[]}
    class ImmediateThread:
        def __init__(self,target,**kwargs):self.target=target
        def start(self):self.target()
        def is_alive(self):return False
    class Quiet:
        def submit(self,*a):pass
        def close(self,**kw):pass
        def abort(self):pass
    class FrontResponse:
        def __enter__(self):return self
        def __exit__(self,*a):pass
        def __iter__(self):return iter([b'data: {"choices":[{"delta":{"content":"Fixture answer. "}}]}\n',b'data: [DONE]\n'])
    import urllib.request as request
    def open_provider(req,**kwargs):state['front'].append(json.loads(req.data));return FrontResponse()
    constants=assignments(root,['WORKISH','AUTO_REASONING','AUTO_EFFORT','REASONING_LEVELS','WORK_MARK','PROMISE','WEB_CAPABLE','WEB_STEP_WORDS','AGENT_SAYS','AGENT_CUES'])
    extras=dict(constants,HERE=str(home),CHAT_SETTINGS_PATH=str(home/'chat_settings.json'),payload=payload,mode='text',
        time=NS(time=time.time,sleep=lambda n:None),threading=NS(Thread=ImmediateThread),
        identity=lambda:'PRIVATE_MEMORY_CANARY',system_for=lambda m:'system',for_model=lambda h:h,now_line=lambda:'clock',shape_hint=lambda *a:'',FRONT_MODEL='fixture-model',DS_KEY='fixture-key',
        urllib=NS(request=NS(Request=request.Request,urlopen=open_provider)),
        my_turn=1,conv=conv,q=row['q'],scope='master',reasoning='none',effort='none',
        recall=lambda *a:[],abandoned={'yes':False},QuietSpeaker=Quiet,counter=[0],work={'needed':False,'said':False},
        out=NS(put=state['events'].append),AGENT_RUN_LOCK=threading.Lock(),AGENT_RUN_WAIT=.01,
        ART_LOG=[],panels_since=lambda n:False,AGENT_CUES=constants['AGENT_CUES'],AGENT_SAYS=constants['AGENT_SAYS'],
        LIVE_LOCK=threading.RLock(),LIVE_TURNS={1:{}},_drop_empty_conversation=lambda c:None,
        chan=NS(started=time.time(),steps=[],finish=state['finished'].append),stats={'t0':time.time(),'tok':None,'audio':None,'work':None},
        is_markup=lambda s:False,units=lambda s:([],s),_session_key=lambda:conv,commit=lambda *a,**kw:True,
        _session_keep_turn=lambda *a,**kw:state['stored'].append(a),_redact=NS(redact=str),
        drop_partial_marker=str,strip_delivery=str,scrub=str,approval_lock=threading.RLock,APPROVAL_SECRETS={},
        approvals_store=lambda:NS(expire=lambda *a,**kw:None),warm_answer=lambda *a,**kw:None,
        RESPONSE_AUTHORING=NS(text_stream=lambda fn:fn,agent_result=lambda fn:fn,requested=lambda p:None),
        write_turn_ctx=lambda *a:'',agent_session_name=str,secrets=NS(token_hex=lambda n:'fixture-secret'),AUTO_ENABLED=False,PORT=49151)
    names=['chat_settings','web_used','front_stream']
    tree=ast.parse((root/'server.py').read_text())
    if any(getattr(n,'name','')=='text_needs_agent' for n in tree.body):names.append('text_needs_agent')
    env=symbols(root,names,extras)
    stream=next(n for n in tree.body if getattr(n,'name','')=='stream')
    # Execute the settings selection exactly as written, not a mirrored settings algorithm.
    start=next(i for i,n in enumerate(stream.body) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='_cs' for t in n.targets))
    end=next(i for i,n in enumerate(stream.body[start:],start) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='want_memory' for t in n.targets))
    block=ast.Module(body=copy.deepcopy(stream.body[start:end+1]),type_ignores=[]);ast.fix_missing_locations(block);exec(compile(block,'<actual settings selection>','exec'),env)
    def agent(prompt,stop,on_event,mode,reasoning,web,memory,**kwargs):
        state['agent'].append({'mode':mode,'web':web,'memory':memory,'web_off':kwargs.get('web_off',False)})
        if agent_impl is not None:return agent_impl(prompt,stop,on_event,mode,reasoning,web,memory,**kwargs)
        if row['web_behavior']=='search':on_event('run','web_search','Search fixture',title='Search fixture')
        elif row['web_behavior']=='private-read':on_event('run','browser_exec','Read private fixture',title='Read private fixture')
        return 'ok','Fixture answer.'
    env['hermes_answer']=agent
    nested=symbols(root,['run'],env,nested='stream');nested['run']()
    return {'selected':{'web':env['_cs']['web'],'memory':env['_cs']['memory'],'want_web':env['want_web'],'web_off':env['web_off'],'want_memory':env['want_memory']},
            'front_requests':state['front'],'agent_calls':state['agent'],'observed_tools':[d['tool'] for k,d in state['events'] if k=='term' and d.get('kind')=='run'],'errors':[d for k,d in state['events'] if k=='err'],'finished':state['finished'],'stored':state['stored']}
