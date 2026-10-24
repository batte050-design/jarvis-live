"""Offline proof through actual emitters, helper decisions, artifact gate and fixed renderer."""
import argparse
import ast
import asyncio
import contextlib
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from unittest.mock import patch

P = argparse.ArgumentParser()
P.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
P.add_argument('--cases', type=Path, default=Path(__file__).with_name('defect6_cases.json'))
P.add_argument('--report', type=Path)
ARGS = P.parse_args()
ROOT = ARGS.root.resolve()
sys.path.insert(0, str(ROOT))
sys.path.insert(1, str(Path(__file__).resolve().parent))
from authoring_agent_support import agent_environment, symbols, Response


def load(name):
    file = ROOT/(name+'.py')
    if not file.exists(): return None
    spec = importlib.util.spec_from_file_location(name, file)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


L = load('response_layer'); S = load('response_sources'); A = load('response_authoring'); O = load('response_openui')
FIXTURE = json.loads((Path(__file__).parent/'fixtures/defect6-series.json').read_text())
QUERY = FIXTURE['request']
QUESTION = 'Compare USD vs UGX for the past 6 months.'


def require_sources():
    assert S is not None, 'turn-owned source validation is absent on this base'


@contextlib.contextmanager
def evidence(question=QUESTION, payload=None, clock=None, network=True, presentation=False):
    require_sources()
    f = copy.deepcopy(FIXTURE['payload'] if payload is None else payload)
    now = dt.datetime.fromisoformat((clock or FIXTURE['clock']).replace('Z','+00:00'))
    with S.turn(question, network=network, fetch=lambda q:copy.deepcopy(f), clock=lambda:now, presentation=presentation) as e:
        yield e


def raises(fn):
    try: fn()
    except (ValueError, ArithmeticError): return
    raise AssertionError('unverified or inconsistent series was accepted')


def emit(e, **changes):
    receipt = e.retrieve(QUERY)
    args = {'title':'MODEL SOURCE: made up yesterday','chart':'line','points':receipt['points'],'source':receipt['source']}
    args.update(changes)
    return A.emit('emit_chart',args)


def js(spec, runtime=False):
    code = """
const fs=require('fs'),root=process.argv[1],input=JSON.parse(fs.readFileSync(0,'utf8'));
const core=require(root+'/static/response-core.js')(JSON.parse(fs.readFileSync(root+'/response-capabilities.json')));
const result=core.validate(input);if(!result.ok)throw Error(result.reason);
if(process.argv[2]==='runtime'){
const {Document}=require(root+'/tests/response_dom.js'),doc=new Document();
const view=require(root+'/static/response-runtime.js')(core,doc,()=>{});
view.mount(result.spec,result.initial,doc.body);
const text=doc.body.textContent;view.destroy();console.log(JSON.stringify({text,charts:doc.body.querySelectorAll('figure').length}));
}else console.log(JSON.stringify({outputs:result.spec.outputs,source:result.spec.source,cost:result.cost}));
"""
    run = subprocess.run(['node','-e',code,str(ROOT),'runtime' if runtime else 'core'],input=json.dumps(spec),text=True,capture_output=True,timeout=10)
    assert run.returncode == 0, run.stdout+run.stderr
    return json.loads(run.stdout)


def declaration_count(text):
    return len(re.findall(r'```ui\s*\n', text))


def decorated(name, env):
    compiled = symbols(ROOT, [name], env)
    node = next(n for n in ast.parse((ROOT/'server.py').read_text()).body if getattr(n,'name','') == name)
    fn = compiled[name]
    for decorator in reversed(node.decorator_list):
        fn = eval(compile(ast.Expression(decorator),'<actual decorator>','eval'),compiled)(fn)
    return fn


class Provider:
    def __init__(self, name='emit_chart', args=None, retrieval=True, provider='yahoo_chart'):
        self.name,self.args,self.retrieval,self.provider = name,args,retrieval,provider
        self.requests=[]
    def __call__(self, request, **kwargs):
        body = json.loads(request.data);self.requests.append(body)
        receipts = [json.loads(m['content']) for m in body['messages'] if m['role']=='tool']
        if self.retrieval and not receipts:
            name='retrieve_series'
            args=copy.deepcopy(QUERY) if self.provider=='yahoo_chart' else {'provider':'user_input','symbol':'','start':'','end':'','period':'month'}
        else:
            name=self.name;args=copy.deepcopy(self.args)
            if name=='emit_chart':
                r=receipts[-1];args={'title':'Invented source caption must be ignored','chart':'line','points':r['points'],'source':r['source']}
            elif name=='emit_budget' and receipts: args['source']=receipts[-1]['source']
        frames=[{'choices':[{'index':0,'delta':{'content':'Apr: 3700. Source: model memory.','tool_calls':[{'index':0,'type':'function','function':{'name':name,'arguments':''}}]}}]}]
        raw=json.dumps(args)
        for i in range(0,len(raw),13): frames.append({'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'function':{'arguments':raw[i:i+13]}}]}}]})
        frames.append({'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]})
        return io.BytesIO((''.join('data: '+json.dumps(f)+'\n\n' for f in frames)+'data: [DONE]\n').encode())


def authored(question, provider):
    with patch('urllib.request.urlopen',provider):
        return A.author(question,[{'role':'system','content':L.prompt_note()},{'role':'user','content':question}],'fixture-model','fixture-key')


def case_missing_source():
    args={'title':'USD/UGX','chart':'line','points':[{'label':'Apr','value':3700},{'label':'May','value':3701}]}
    raises(lambda:A.emit('emit_chart',args))


def case_fixture_build():
    with evidence() as e:
        spec=emit(e)
        assert spec['source']['sha256']==hashlib.sha256(S.canonical(FIXTURE['payload']).encode()).hexdigest()
        assert spec['outputs'][0]['points'][0]['value']==3682.25
        assert js(spec)['source']==spec['source']


def case_source_changes_with_clock():
    with evidence() as e:first=js(emit(e),True)['text']
    with evidence(clock='2026-10-23T12:01:02Z') as e:second=js(emit(e),True)['text']
    assert '2026-10-23T12:00:00Z' in first and '2026-10-23T12:01:02Z' in second
    assert first!=second and 'MODEL SOURCE' not in first and 'Invented source' not in first


def case_observation_timestamp():
    payload=copy.deepcopy(FIXTURE['payload'])
    payload['chart']['result'][0]['timestamp'][-1]-=86400
    with evidence(payload=payload) as e:
        text=js(emit(e),True)['text'];assert 'observations through: 2026-10-21' in text


def case_no_fill():
    with evidence() as e:
        spec=emit(e)
        assert '2026-06' not in [p['label'] for p in spec['outputs'][0]['points']]
        assert spec['source']['missing']==['2026-06']
        assert spec['outputs'][0]['chart']=='bar', 'missing months must not be bridged by a line'
        assert 'missing: 2026-06' in js(spec,True)['text']


def case_empty_or_failed_retrieval():
    empty=json.loads((Path(__file__).parent/'fixtures/defect6-empty.json').read_text())
    for payload in (empty,{'chart':{'error':None,'result':[]}}):
        with evidence(payload=payload):
            status,text=authored(QUESTION,Provider())
            assert status=='ok' and declaration_count(text)==0 and 'could not source' in text and 'would need' in text
    with evidence() as e:
        e.fetch=lambda q:(_ for _ in ()).throw(OSError('fixture upstream offline'))
        status,text=authored(QUESTION,Provider())
        assert status=='ok' and declaration_count(text)==0 and 'could not source' in text


def case_repeat_rejected():
    payload=copy.deepcopy(FIXTURE['payload']);payload['chart']['result'][0]['indicators']['quote'][0]['close'][2]=3682.25
    with evidence(payload=payload):
        status,text=authored(QUESTION,Provider());assert declaration_count(text)==0 and 'could not source' in text


def case_wrong_points():
    with evidence() as e:
        r=e.retrieve(QUERY);points=copy.deepcopy(r['points']);points[0]['value']=3700
        raises(lambda:A.emit('emit_chart',{'title':'rates','chart':'line','points':points,'source':r['source']}))


def case_foreign_receipt():
    with evidence() as e:receipt=e.retrieve(QUERY)
    with evidence(): raises(lambda:A.emit('emit_chart',{'title':'rates','chart':'line','points':receipt['points'],'source':receipt['source']}))


def case_source_tamper():
    with evidence() as e:
        r=e.retrieve(QUERY)
        for field,value in [('tool','web_search'),('timestamp','2020-01-01T00:00:00Z'),('query','different query'),('sha256','0'*64)]:
            source={**r['source'],field:value}
            raises(lambda:A.emit('emit_chart',{'title':'rates','chart':'line','points':r['points'],'source':source}))


def case_one_chart():
    with evidence() as e:
        spec=emit(e);guard=A.TextSafety();text=guard.feed(A.fence(spec)+A.fence(spec))+guard.finish()
        assert declaration_count(text)==1, text
        assert e.published==1


def case_mixed_narrative():
    require_sources()
    points=[{'label':'Apr','value':3682.254}]
    assert S.consistent('Apr: 3682.25',points)
    raises(lambda:S.consistent('Apr: 3700',points))
    with evidence():
        status,text=authored(QUESTION,Provider());assert status=='ok'
        assert 'Apr: 3700' not in text and 'Source: model memory' not in text
        spec=json.loads(re.search(r'```ui\n(.*)\n```',text,re.S)[1])
        assert all(o['kind']=='chart' for o in spec['outputs'])


def case_numeric_prose():
    with evidence() as e:
        receipt=e.retrieve(QUERY)
        text=S.describe(receipt)
        assert declaration_count(text)==0 and receipt['source']['timestamp'] in text
        assert S.source_line(receipt['source']) in text
        for p in receipt['points']:assert p['label']+': '+str(p['value']) in text


def case_illustration():
    require_sources()
    args={'title':'Observed market 2026','chart':'bar','points':[{'label':'Example A','value':5},{'label':'Example B','value':10}]}
    with evidence(question='Show a synthetic illustration.'):
        spec=A.emit('emit_illustration',args);result=js(spec,True)
        assert 'Illustration: synthetic, unmeasured values.' in result['text']
        assert '2026' not in result['text'] and 'Source:' not in result['text']
        assert spec['source']=={'kind':'illustration'}
    with evidence():raises(lambda:A.emit('emit_illustration',args))


def case_artifact_gate():
    require_sources()
    env={'RESPONSE_AUTHORING':A,'art_token_ok':lambda r:True,'auth_scope':lambda r:'master','same_origin':lambda r:True,
         'ART_MAX_BYTES':400000,'ART_KINDS':('chart','widget','text','clear'),'ART_SEQ':[0],'broadcast_art':lambda p:99}
    fn=symbols(ROOT,['art'],env)['art']
    class Request:
        async def body(self):return b'{"kind":"chart","data":[["Apr",3700],["May",3701]]}'
    with evidence(presentation=True):
        response=asyncio.run(fn(Request()));assert isinstance(response,Response) and response.status_code==409
        for kind in ('widget','image','table','text'):assert not S.artifact_allowed({'kind':kind})
        assert not S.artifact_allowed({'kind':'chart','mode':'voice'})
        assert not S.artifact_allowed({'clear':True})
    assert not S.artifact_allowed({'kind':'chart'})
    with S.publisher('voice','a'*32) as grant:
        assert S.artifact_allowed({'kind':'chart','publication':grant})
    assert not S.artifact_allowed({'kind':'chart','publication':grant})


def case_no_format_words_model_choice():
    prompts=['Compare Basic at USD 5 and Pro at USD 10.','Plan my budget: income 1000000; housing 300000; food 200000; other 100000.','Compare USD vs UGX for the past 6 months.']
    for q in prompts:assert A.requested(q),q
    with evidence():
        provider=Provider(name='reply_prose',args={'text':'The options differ in storage; a short explanation is enough.'},retrieval=False)
        status,text=authored(prompts[0],provider)
        assert status=='ok' and declaration_count(text)==0
        names={t['function']['name'] for t in provider.requests[0]['tools']}
        assert {'emit_chart','emit_comparison','emit_budget','reply_prose','retrieve_series'} <= names
    with evidence():
        p=Provider();status,text=authored(prompts[2],p);assert status=='ok' and declaration_count(text)==1


class OpenUIProvider:
    def __init__(self,query):self.query=query;self.requests=[]
    def __call__(self,request,**kwargs):
        body=json.loads(request.data);self.requests.append(body)
        tools=[m for m in body['messages'] if m['role']=='tool']
        if not tools:
            delta={'tool_calls':[{'index':0,'id':'r1','type':'function','function':{'name':'retrieve_series','arguments':json.dumps(self.query)}}]}
        else:
            receipt=json.loads(tools[-1]['content']);rid=receipt['receipt_id']
            delta={'content':'Verified series.\n```openui\nroot = Col([Chart("bar", @Receipt("'+rid+'"), "label", ["value"])])\n```\n'}
        return io.BytesIO(('data: '+json.dumps({'choices':[{'delta':delta}]})+'\n\ndata: [DONE]\n').encode())


def case_fast_real_helper():
    q='Show the trend from supplied figures: January 10, February 20, March 15.'
    env={'OPENUI':O,'FRONT_MODEL':'fixture','DS_KEY':'fixture','recall':lambda:[], 'for_model':lambda r:r}
    fn=decorated('front_stream',env);provider=OpenUIProvider({'provider':'user_input','symbol':'','start':'','end':'','period':'month'})
    with patch('urllib.request.urlopen',provider):text=''.join(fn(q,mode='text'))
    assert text.count('```openui\n')==1,text
    assert O.finalize(text)[0]=='ok'
    # The bounded repair round may spend up to two further provider calls when the first program
    # does not compile, or when a calculation arrives with no adjustable control. Two is the
    # ordinary path; four is the ceiling.
    assert 2 <= len(provider.requests) <= 4, len(provider.requests)


def case_deep_real_helper():
    require_sources()
    with tempfile.TemporaryDirectory() as temp:
        home=Path(temp);binary=home/'hermes'
        raw='<<<SPOKEN Verified series findings. SPOKEN>>>'
        binary.write_text('#!'+sys.executable+'\nimport json\nprint(json.dumps({"type":"result","text":'+repr(raw)+'}))\n');binary.chmod(0o700)
        env=agent_environment(ROOT,home,binary);env.update(OPENUI=O,RESPONSE_AUTHORING=A,FRONT_MODEL='fixture',DS_KEY='fixture')
        fn=decorated('hermes_answer',env);events=[];provider=OpenUIProvider(QUERY)
        with evidence(),patch('urllib.request.urlopen',provider):
            status,text=fn(QUESTION,mode='text',web=True,conv='a'*32,on_event=lambda kind,tool,line,*a,**k:events.append((kind,line)))
        assert status=='ok' and text.count('```openui\n')==1,text
        assert O.finalize(text)[0]=='ok'
        assert ''.join(line for kind,line in events if kind=='live')==text


def case_web_off():
    with evidence(network=False):
        status,text=authored(QUESTION,Provider());assert status=='ok' and declaration_count(text)==0 and 'could not source' in text


def case_ordinary_and_voice():
    for text in ['Hello.\n','| A | B |\n| --- | --- |\n| 1 | 2 |\n','[[file:report.pdf]]','````markdown\n```ui\nExample\n```\n````']:
        assert A.clean(text)==text
    assert A.requested('Hello Jarvis.') is None
    assert A.requested('What is 7 times 8?') is None
    assert A.clean('```ui\nA sentence, no declaration.\n```')=='A sentence, no declaration.\n'
    calls=[]
    def voice(prompt,mode='voice',on_event=None):
        if on_event:on_event('live','','unchanged')
        return 'ok','unchanged'
    assert A.agent_result(voice)('hi',mode='voice',on_event=lambda *a:calls.append(a))==('ok','unchanged')
    assert calls==[('live','','unchanged')]


def case_bare_and_legacy():
    raw=json.dumps({'type':'chart','kind':'line','data':[['Apr',3700],['May',3701]]})
    for text in (raw+'\n','```ui\n'+raw+'\n```\n'):
        with evidence():
            out=A.clean(text);assert '"data"' not in out and 'could not source' in out


def case_no_network_or_redirect_escape():
    require_sources()
    for symbol in ('https://evil.test/x','../admin','127.0.0.1/path','UGX=X?host=x'):
        raises(lambda:S.fetch_yahoo({**QUERY,'symbol':symbol}))
    raises(lambda:S.NoRedirect().redirect_request(None,None,302,'redirect',{},'http://127.0.0.1'))


def case_protected_boundaries():
    # Source-byte pins are stable across Python AST versions. Every intentional change carries its
    # exact 8c2e433 preimage and reviewed postimage; untouched files/symbols retain their base hash.
    expected=json.loads((Path(__file__).parent/'fixtures/defect6-boundaries.json').read_text())
    for name,row in expected['files'].items():
        assert hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==row['after'],name
    source=(ROOT/'server.py').read_text();lines=source.splitlines(keepends=True)
    for node in ast.parse(source).body:
        if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef,ast.ClassDef)):
            start=min([node.lineno]+[d.lineno for d in node.decorator_list])-1
            actual=hashlib.sha256(''.join(lines[start:node.end_lineno]).encode()).hexdigest()
            assert actual==expected['server_symbols'][node.name]['after'],node.name
    assert hashlib.sha256(source.encode()).hexdigest()==expected['server_sha256']
    painter=(ROOT/'static/v1.js').read_text();painter=re.sub(r'/\* response-assets: [0-9a-f]+ \*/','',painter)
    assert hashlib.sha256(painter.encode()).hexdigest()==expected['painter_after_sha256']
    inline=re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',(ROOT/'index_v1.html').read_text(),re.S)
    assert hashlib.sha256(json.dumps(inline).encode()).hexdigest()==expected['inline_scripts_sha256']


def case_concurrent_turn_isolation():
    require_sources()
    import threading
    barrier=threading.Barrier(2);receipts=[];errors=[]
    def run():
        try:
            with evidence() as e:
                own=e.retrieve(QUERY);receipts.append(own);barrier.wait(timeout=5)
                other=next(r for r in receipts if r is not own)
                raises(lambda:e.checked(other['source']))
                assert e.checked(own['source'])==own
        except Exception as exc:errors.append(exc)
    threads=[threading.Thread(target=run) for _ in range(2)]
    for t in threads:t.start()
    for t in threads:t.join(timeout=6)
    assert not any(t.is_alive() for t in threads) and not errors,errors


def case_wrong_query_or_window():
    with evidence() as e:
        raises(lambda:e.retrieve({**QUERY,'symbol':'EUR=X'}))
        raises(lambda:e.retrieve({**QUERY,'start':'2025-04-23'}))
        # f60309b explicitly allows three days of date rounding. Keep that deployed policy;
        # the former one-day negative expectation was stale even before this repair.
        raises(lambda:e.retrieve({**QUERY,'end':'2026-10-19'}))


def case_provider_refusal_is_failed():
    with evidence(),patch('urllib.request.urlopen',side_effect=OSError('fixture provider refused')):
        status,text=A.author(QUESTION,[{'role':'user','content':QUESTION}],'fixture','fixture')
        assert status=='failed' and declaration_count(text)==0
    def refusal(*a,**k):
        return io.BytesIO(b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\ndata: [DONE]\n')
    with evidence(),patch('urllib.request.urlopen',refusal):
        status,text=A.author(QUESTION,[{'role':'user','content':QUESTION}],'fixture','fixture')
        assert status=='failed' and declaration_count(text)==0


def case_chosen_prose_keeps_paragraphs_and_table():
    q='Compare Basic at USD 5 and Pro at USD 10.'
    words='Basic costs less.\n\n| Option | USD |\n| --- | --- |\n| Basic | 5 |\n| Pro | 10 |\n'
    with evidence(question=q):
        status,text=authored(q,Provider(name='reply_prose',args={'text':words},retrieval=False))
        assert status=='ok' and text==words and declaration_count(text)==0


def case_delayed_side_push_after_text_answer():
    require_sources()
    env={'RESPONSE_AUTHORING':A,'art_token_ok':lambda r:True,'auth_scope':lambda r:'master','same_origin':lambda r:True,
         'ART_MAX_BYTES':400000,'ART_KINDS':('chart','widget','text','clear'),'ART_SEQ':[0],'broadcast_art':lambda p:99}
    fn=symbols(ROOT,['art'],env)['art']
    class Request:
        async def body(self):return b'{"kind":"chart","data":[["Apr",3700],["May",3701]]}'
    with evidence(presentation=True) as e:
        spec=emit(e);assert declaration_count(A.clean(A.fence(spec)))==1
    response=asyncio.run(fn(Request()))
    assert isinstance(response,Response) and response.status_code==409, 'A delayed unscoped /art push is accepted after the text helper ends; screen_show must carry trusted turn identity without breaking voice.'


CASES={name[5:]:fn for name,fn in list(globals().items()) if name.startswith('case_')}
if __name__=='__main__':
    wanted=json.loads(ARGS.cases.read_text())
    results=[]
    for case in wanted:
        name=case['case']
        try:CASES[name]();status='PASS';detail=''
        except Exception as exc:status='FAIL';detail=type(exc).__name__+': '+str(exc)[:500]
        print(status+' defect6/'+name+(' — '+detail if detail else ''),flush=True)
        results.append({'case':name,'status':status,'detail':detail})
    if ARGS.report:ARGS.report.write_text(json.dumps(results,indent=2)+'\n')
    sys.exit(1 if any(r['status']=='FAIL' for r in results) else 0)
