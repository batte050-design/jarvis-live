"""Real helper/decoder tests with scripted HTTP and child boundaries, NOT live model results."""
import argparse
import ast
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from authoring_agent_support import agent_environment, symbols, module

P=argparse.ArgumentParser();P.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);P.add_argument('--report',type=Path);P.add_argument('--prompt-note-sha256');A,REST=P.parse_known_args();ROOT=A.root.resolve();HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parent))
spec=importlib.util.spec_from_file_location('authoring_test',HERE.parent/'response_authoring.py');AUTHOR=importlib.util.module_from_spec(spec);spec.loader.exec_module(AUTHOR)
import response_openui as OPENUI
LAYER=module(ROOT,'response_layer');ROWS=json.loads((HERE/'authoring10.json').read_text())


def decorated(root,name,env):
    compiled=symbols(root,[name],env);fn=compiled[name]
    node=next(n for n in ast.parse((root/'server.py').read_text()).body if getattr(n,'name','')==name)
    for decorator in reversed(node.decorator_list):
        fn=eval(compile(ast.Expression(decorator),'<actual helper decorator>','eval'),compiled)(fn)
    return fn


def provider(row,seen,*,events=None):
    def opened(request,**kwargs):
        body=json.loads(request.data);seen.append({'url':request.full_url,'body':body})
        if events is None:
            if body.get('tools'):
                args=copy.deepcopy(row['arguments']);name=row['tool'];frames=[]
                prior=[json.loads(m['content']) for m in body['messages'] if m['role']=='tool']
                if name in ('emit_chart','emit_budget'):
                    if not prior:
                        name='retrieve_series';args={'provider':'user_input','symbol':'','start':'','end':'','period':'month'}
                    else:args['source']=prior[-1]['source']
                raw=json.dumps(args)
                frames.append({'choices':[{'index':0,'delta':{'content':'Drag the slider below. [[file:calculator.html]]','tool_calls':[{'index':0,'id':'fixture','type':'function','function':{'name':name,'arguments':''}}]}}]})
                for i in range(0,len(raw),7):frames.append({'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'function':{'arguments':raw[i:i+7]}}]}}]})
                frames.append({'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]})
            else:
                content=row.get('answer','```ui\nPricing is linear. Drag the slider below.\n```')
                frames=[{'choices':[{'delta':{'content':content[i:i+5]}}]} for i in range(0,len(content),5)]
        else:frames=events
        value=''.join('data: '+json.dumps(x)+'\n\n' for x in frames)+'data: [DONE]\n'
        return io.BytesIO(value.encode())
    return opened


def front(root,row,seen):
    # The old typed emitter remains for stored components and voice compatibility, not text routing.
    if row['shape']=='prose':
        fn=symbols(root,['front_stream'],{'OPENUI':OPENUI,'FRONT_MODEL':'fixture-model','DS_KEY':'fixture-key','recall':lambda:[],'for_model':lambda h:h})['front_stream']
        with patch('urllib.request.urlopen',provider(row,seen,events=[{'choices':[{'delta':{'content':row['answer']}}]}])):
            return ''.join(fn(row['prompt'],mode='text'))
    with patch('urllib.request.urlopen',provider(row,seen)):
        return AUTHOR.author(row['prompt'],[{'role':'user','content':row['prompt']+LAYER.prompt_note()}],'fixture-model','fixture-key')[1]


def deep(root,row,seen):
    with tempfile.TemporaryDirectory() as d:
        home=Path(d);binary=home/'hermes'
        facts=row.get('answer','A calculation can use the supplied numbers. Drag the slider below. [[file:calculator.html]]')
        binary.write_text('#!'+sys.executable+'\nimport json\nprint(json.dumps({"type":"text","text":'+repr('<<<SPOKEN '+facts+' SPOKEN>>>')+'}))\nprint(json.dumps({"type":"result","text":'+repr('<<<SPOKEN '+facts+' SPOKEN>>>')+'}))\n');binary.chmod(0o700)
        env=agent_environment(root,home,binary);env.update(RESPONSE_AUTHORING=AUTHOR,FRONT_MODEL='fixture-model',DS_KEY='fixture-key')
        fn=AUTHOR.agent_result(symbols(root,['hermes_answer'],env)['hermes_answer']);live=[]
        with patch('urllib.request.urlopen',provider(row,seen)):
            status,text=fn(row['prompt'],mode='text',web=True,conv='a'*32,on_event=lambda kind,tool,line,*a,**k:live.append((kind,line)))
        return status,text,live


def shape(text):
    import re
    match=re.search(r'^```ui\n(.+)\n```',text,re.M)
    if not match:return 'prose'
    try:return json.loads(match[1]).get('component','prose')
    except (ValueError,AttributeError):return 'prose'


class AuthoringTests(unittest.TestCase):
    def test_legacy_typed_emitters_and_decorated_agent_compatibility(self):
        report=[]
        for row in ROWS:
            for lane in ('fast','deep'):
                with self.subTest(prompt=row['id'],lane=lane):
                    seen=[]
                    if lane=='fast':text=front(ROOT,row,seen);status='ok';live=[]
                    else:status,text,live=deep(ROOT,row,seen)
                    actual=shape(text);ok=status=='ok' and actual==row['shape']
                    report.append({'id':row['id'],'prompt':row['prompt'],'lane':lane,'expected':row['shape'],'actual':actual,'status':'PASS' if ok else 'FAIL','provider_http_calls':len(seen),'answer':text})
                    self.assertTrue(ok,(row['id'],lane,status,actual,text))
                    if row['shape']=='prose':
                        self.assertEqual(text,row['answer']);self.assertEqual(len(seen),1 if lane=='fast' else 0)
                    else:
                        self.assertEqual(len(seen),0 if row.get('tool')=='emit_chart' else 2 if row.get('tool')=='emit_budget' else 1);self.assertNotIn('calculator.html',text);self.assertNotIn('Drag the slider',text)
                        self.assertTrue(all('calculator.html' not in value for kind,value in live if kind=='live'))
                        if seen:
                            body=seen[0]['body'];self.assertEqual(body['tool_choice'],'required')
                            # The existing freeform composition graph is non-strict; the typed
                            # emitters retain strict schemas. Emission/validation above still applies.
                            for tool in body['tools']:
                                self.assertEqual(tool['function']['strict'],tool['function']['name']!='emit_composition')
                            self.assertTrue(any(LAYER.prompt_note() in m['content'] for m in body['messages']),'existing instruction block missing')
                        else:
                            self.assertEqual(row['tool'],'emit_chart')
                            self.assertEqual(json.loads(text.split('```ui\n')[1].split('\n```')[0])['source']['kind'],'provided')
        if A.report:A.report.write_text(json.dumps({'kind':'SCRIPTED provider/child boundaries; actual server helpers, not native acceptance','rows':report},indent=2)+'\n')

    def test_all_server_specs_pass_the_existing_js_validator_and_recompute(self):
        values=[]
        for row in ROWS:
            if row['shape']=='prose':continue
            with AUTHOR.SOURCES.turn(row['prompt']) as evidence:
                args=copy.deepcopy(row['arguments'])
                if row['tool'] in ('emit_chart','emit_budget'):
                    receipt=evidence.retrieve({'provider':'user_input','symbol':'','start':'','end':'','period':'month'});args['source']=receipt['source']
                values.append(AUTHOR.emit(row['tool'],args))
        code="const fs=require('fs'),root=process.argv[1],core=require(root+'/static/response-core.js')(JSON.parse(fs.readFileSync(root+'/response-capabilities.json')));const rows=JSON.parse(fs.readFileSync(0));for(const spec of rows){const r=core.validate(spec);if(!r.ok)throw Error(spec.component+': '+r.reason);let e=core.evaluate(r.spec,r.initial);if(spec.component==='quote-estimator'){if(e.total!==17004)throw Error('quote total');const next={...r.initial,quantity:7};if(core.evaluate(r.spec,next).total!==19838)throw Error('quote recompute');}if(spec.component==='bill-splitter'&&e.perPerson*e.regularPeople+e.extraShare*e.extraPeople!==100001)throw Error('bill allocation');if(spec.component==='budget-planner'&&e.remaining!==400000)throw Error('budget');console.log('PASS existing validator '+spec.component);}"
        run=subprocess.run(['node','-e',code,str(ROOT)],input=json.dumps(values),text=True,capture_output=True)
        self.assertEqual(run.returncode,0,run.stdout+run.stderr);print(run.stdout,end='')

    def test_sse_partial_unknown_extra_truncated_prose_and_decline(self):
        row=ROWS[0]
        def frame(name,args):return {'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'function':{'name':name,'arguments':args}}]},'finish_reason':'tool_calls'}]}
        invalid=[[],[{'choices':[{'delta':{'content':'```ui\nA sentence.\n```'},'finish_reason':'stop'}]}],[frame('not_allowlisted','{}')],[frame('emit_quote','{')],[frame('emit_quote',json.dumps({**row['arguments'],'html':'<script>'}))],[frame('emit_quote',json.dumps({**row['arguments'],'quantity':True}))],[frame('decline_response','{"reason":"missing_inputs"}')],[frame('emit_quote','{"quantity":1,"quantity":2}')]]
        for events in invalid:
            seen=[]
            with patch('urllib.request.urlopen',provider(row,seen,events=events)):
                status,text=AUTHOR.author(row['prompt'],[{'role':'user','content':row['prompt']}],'fixture','fixture')
            self.assertEqual((status,text),('failed',AUTHOR.FAILED));self.assertNotIn('{',text);self.assertNotIn('```ui',text)
        with patch('urllib.request.urlopen',side_effect=OSError('provider refusal')):
            self.assertEqual(AUTHOR.author(row['prompt'],[{'role':'user','content':'x'}],'m','k')[0],'failed')
        with patch('urllib.request.urlopen') as http:
            self.assertEqual(AUTHOR.author(row['prompt'],[],'m','k',stop=lambda:True),('stopped',''));http.assert_not_called()

    def test_prose_ui_fences_fall_back_before_the_painter_and_claims_never_leak(self):
        samples=[('```ui\nPricing is linear, not tapered.\n```','Pricing is linear, not tapered.\n'),('Drag the slider below.\n',AUTHOR.INSTRUCTIONS+'\n'),('Tap the button below.\n',AUTHOR.INSTRUCTIONS+'\n'),('```ui\n{"bad":\n```','')]
        for raw,expected in samples:
            for cut in range(len(raw)+1):
                guard=AUTHOR.TextSafety();self.assertEqual(guard.feed(raw[:cut])+guard.feed(raw[cut:])+guard.finish(),expected)
        self.assertEqual(AUTHOR.clean('[[file:comparison.html]]',True),AUTHOR.FAILED+'\n')
        self.assertEqual(AUTHOR.clean('[[file:report.html]]',False),'[[file:report.html]]')
        for raw in ['ordinary prose\n\nMore prose.','[[file:report.pdf]]','| A | B |\n| 1 | 2 |','```python\nprint("tap the button")\n```','````markdown\n```ui\nNot a declaration\n```\n````']:
            for cut in range(len(raw)+1):
                guard=AUTHOR.TextSafety();self.assertEqual(guard.feed(raw[:cut])+guard.feed(raw[cut:])+guard.finish(),raw)

    def test_failed_and_voice_agent_results_do_not_author_or_change_callbacks(self):
        calls=[]
        def real(prompt,stop=None,on_event=None,mode='voice'):
            if on_event:on_event('live','','Drag the slider below.')
            return 'failed','original failure'
        real.__globals__.update(FRONT_MODEL='fixture',DS_KEY='fixture')
        wrapped=AUTHOR.agent_result(real)
        with patch.object(AUTHOR,'author',side_effect=AssertionError('must not call')):
            self.assertEqual(wrapped(ROWS[0]['prompt'],mode='text'),('failed','original failure'))
            self.assertEqual(wrapped(ROWS[0]['prompt'],on_event=lambda *a:calls.append(a),mode='voice'),('failed','original failure'))
        self.assertEqual(calls,[('live','','Drag the slider below.')])

    def test_front_provider_failure_uses_the_existing_failure_path(self):
        row=ROWS[0]
        env={'OPENUI':OPENUI,'RESPONSE_AUTHORING':AUTHOR,'FRONT_MODEL':'fixture','DS_KEY':'fixture','identity':lambda:'','system_for':lambda mode:'system','recall':lambda:[],
             'for_model':lambda rows:rows,'now_line':lambda:'clock','shape_hint':lambda mode,q:LAYER.prompt_note()}
        fn=decorated(ROOT,'front_stream',env)
        with patch('urllib.request.urlopen',side_effect=OSError('refused')):
            # No answer exists to fall back to. The worker must report failure, rather than
            # silently returning an empty partial or handing the question to a broad agent.
            with self.assertRaisesRegex(ValueError,'No complete answer'):
                ''.join(fn(row['prompt'],mode='text'))

    def test_front_cancellation_closes_provider_before_any_spec_is_painted(self):
        row=ROWS[0];seen=[];opened=[]
        def open_request(*a,**kw):
            response=io.BytesIO(b'data: {"choices":[{"delta":{"content":"Useful answer.\\n"}}]}\n\ndata: [DONE]\n')
            opened.append(response);return response
        env={'OPENUI':OPENUI,'RESPONSE_AUTHORING':AUTHOR,'FRONT_MODEL':'fixture','DS_KEY':'fixture','identity':lambda:'','system_for':lambda mode:'system','recall':lambda:[],
             'for_model':lambda rows:rows,'now_line':lambda:'clock','shape_hint':lambda mode,q:LAYER.prompt_note()}
        fn=decorated(ROOT,'front_stream',env)
        with patch('urllib.request.urlopen',open_request):
            stream=fn(row['prompt'],mode='text')
            self.assertEqual(next(stream),'Useful answer.\n')
            stream.close()
        self.assertTrue(opened[0].closed,'cancel did not close the HTTPS response')

    def test_frame_configuration_and_checkpoint_hash_do_not_change(self):
        raw=json.loads((ROOT/'response-capabilities.json').read_text());raw.pop('authoring',None)
        manifest,digest,stamp,core,runtime,style=LAYER.assets()
        self.assertEqual(manifest,raw)
        source=LAYER.canonical(raw)
        self.assertEqual(digest,hashlib.sha256(source.encode()).hexdigest())
        self.assertEqual(stamp,hashlib.sha256(LAYER.canonical([source,core,runtime,style]).encode()).hexdigest())
        self.assertNotIn('authoring',LAYER.config_script())

    def test_adjust_myself_is_classified_unsupported_and_answers_as_prose(self):
        # The request for a self-adjustable control is still recognised and still never authored,
        # but a dead turn is not an answer: the front path now skips authoring for it and the
        # model answers in words. Assert both halves of that contract.
        self.assertEqual(AUTHOR.requested('Build me something I can adjust myself.'),'unsupported')
        code=(ROOT/'server.py').read_text()
        self.assertNotIn('RESPONSE_AUTHORING.requested(prompt)',code,
                         'classifier must not gate the new text composer')

    def test_table_requests_stay_with_the_painter(self):
        for prompt in ['Compare three Kampala buildings in a table: name, units, monthly rent.',
                       'Show this as a table',
                       'Give me a table of the fees',
                       'Tabular breakdown please']:
            self.assertIsNone(AUTHOR.requested(prompt),prompt)
        self.assertEqual(AUTHOR.requested('Compare USD vs UGX over the last 6 months'),'auto')
        self.assertEqual(AUTHOR.requested('Plot a bar chart: January 10, February 20, March 15'),'auto')

    def test_coding_artifacts_and_explanations_do_not_enter_authoring(self):
        for prompt in ['Explain how to build a React widget.','What is a quiz?','Write a Python function to plot a bar chart.','Build a React quote card component.','Create a website with a pricing chart.','Create a CSV export for my budget.','Explain how an HTML calculator works.']:
            self.assertIsNone(AUTHOR.requested(prompt),prompt)
        self.assertEqual(AUTHOR.requested('Build an HTML quote calculator.'),'emit_quote')

    def test_quiz_question_can_ask_for_a_choice_without_promising_a_missing_control(self):
        args=copy.deepcopy(ROWS[5]['arguments']);args['question']='Select the correct option: which number is even?'
        self.assertEqual(AUTHOR.emit('emit_quiz',args)['outputs'][0]['question'],args['question'])
        args['question']='Drag the slider below.'
        with self.assertRaises(ValueError):AUTHOR.emit('emit_quiz',args)

    def test_integral_json_numbers_are_valid_but_boolean_numbers_are_not(self):
        args=copy.deepcopy(ROWS[0]['arguments']);args['quantity']=6.0
        self.assertEqual(AUTHOR.emit('emit_quote',args)['initial']['quantity'],6)
        args['quantity']=True
        with self.assertRaises(ValueError):AUTHOR.emit('emit_quote',args)

    def test_prompt_note_code_and_bytes_remain_unchanged(self):
        actual=LAYER.prompt_note()
        original=json.loads((ROOT/'response-capabilities.json').read_text());original.pop('authoring',None)
        with patch.object(LAYER,'assets',return_value=(original,)):
            self.assertEqual(actual,LAYER.prompt_note(),'authoring metadata changed the instruction block')
        if A.prompt_note_sha256:
            self.assertEqual(hashlib.sha256(actual.encode()).hexdigest(),A.prompt_note_sha256,'original deployed instruction bytes changed')
        code=(ROOT/'server.py').read_text();self.assertEqual(code.count('RESPONSE_LAYER.prompt_note()'),3)

if __name__=='__main__':unittest.main(argv=['test_response_authoring.py']+REST)
