"""f60309b regressions: supplied-data charts and authenticated, turn-bound side publication."""
import asyncio
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import response_authoring as A
import response_sources as S
import response_layer as L
from authoring_agent_support import symbols, Response, agent_environment

Q='Draw one bar chart from my supplied figures: January 10, February 20, March 15.'
QUERY={'provider':'user_input','symbol':'','start':'','end':'','period':'month'}


def screen_module():
    spec=importlib.util.spec_from_file_location('screen_publisher',ROOT/'plugins/screen/tools.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def route(payload):
    sent=[]
    env={'RESPONSE_AUTHORING':A,'art_token_ok':lambda r:True,'auth_scope':lambda r:'master',
         'same_origin':lambda r:True,'ART_MAX_BYTES':400000,'ART_KINDS':('chart','widget','text','clear'),
         'ART_SEQ':[0],'broadcast_art':lambda p:sent.append(copy.deepcopy(p)) or 1}
    compiled=symbols(ROOT,['art'],env)
    class Request:
        async def body(self):return json.dumps(payload).encode()
    return asyncio.run(compiled['art'](Request())),compiled['ART_SEQ'][0],sent


class CurrentRepairs(unittest.TestCase):
    def test_explicit_supplied_chart_needs_no_provider_and_draws_exact_values(self):
        with patch('urllib.request.urlopen',side_effect=AssertionError('no model or network needed')) as http:
            with S.turn(Q):
                status,text=A.author(Q,[{'role':'user','content':Q}],'fixture','')
                self.assertEqual(status,'ok',text)
                self.assertIn('```ui\n',text)
                spec=json.loads(text.split('```ui\n')[1].split('\n```')[0])
                self.assertEqual(spec['source']['kind'],'provided')
                self.assertEqual(spec['outputs'][0]['points'],[{'label':'January','value':10},{'label':'February','value':20},{'label':'March','value':15}])
                self.assertIn('supplied',spec['fallback'].lower())
                self.assertNotIn('retrieved:',spec['fallback'])
                self.assertEqual(S.check_spec(spec),spec)
            http.assert_not_called()

    def test_supplied_equal_values_are_valid_data_not_fabricated_fill(self):
        question='Plot my values: January 10, February 10, March 15.'
        with S.turn(question) as e:
            receipt=e.retrieve(QUERY)
            spec=A.emit('emit_chart',{'title':'provided','chart':'bar','points':receipt['points'],'source':receipt['source']})
            self.assertEqual(spec['outputs'][0]['points'][1]['value'],10)
            import subprocess
            code="const fs=require('fs'),core=require('./static/response-core.js')(JSON.parse(fs.readFileSync('response-capabilities.json'))),r=core.validate(JSON.parse(fs.readFileSync(0)));if(!r.ok)throw Error(r.reason);"
            result=subprocess.run(['node','-e',code],cwd=ROOT,input=json.dumps(spec),text=True,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)

    def test_invalid_supplied_series_degrades_to_readable_words(self):
        question='Chart my data: January 10, January 20, March 15.'
        status,text=A.author(question,[{'role':'user','content':question}],'fixture','')
        self.assertEqual(status,'ok')
        self.assertIn('distinct labels',text)
        self.assertNotIn('```',text)

    def test_changed_supplied_values_and_forged_receipts_are_rejected(self):
        with S.turn(Q) as e:
            receipt=e.retrieve(QUERY)
            args={'title':'provided','chart':'bar','points':copy.deepcopy(receipt['points']),'source':receipt['source']}
            args['points'][0]['value']=99
            with self.assertRaises(ValueError):A.emit('emit_chart',args)
            args['points']=receipt['points'];args['source']={**receipt['source'],'retrieval_id':'0'*32}
            with self.assertRaises(ValueError):A.emit('emit_chart',args)

    def test_supplied_parser_preserves_thousands_negative_and_decimal_values(self):
        self.assertEqual(S.supplied_points('Chart my data: Sales 1,200; Costs -25.5; Balance 1174.5'),
                         [{'label':'Sales','value':1200},{'label':'Costs','value':-25.5},{'label':'Balance','value':1174.5}])

    def test_real_stream_worker_does_not_append_schema_to_user_evidence(self):
        from routing40_driver import drive
        rows=json.loads((ROOT/'tests/routing40.json').read_text())
        row=copy.deepcopy(next(r for r in rows if r['agent'] and r['web']=='auto'))
        row['q']=Q
        seen=[]
        def agent(prompt,*args,**kwargs):seen.append(prompt);return 'ok','Fixture answer.'
        import routing40_driver
        actual_symbols=routing40_driver.symbols
        def compiled(root,names,extra=None,nested=None):
            return actual_symbols(root,names,{**(extra or {}),'RESPONSE_LAYER':L},nested)
        with tempfile.TemporaryDirectory() as d,patch('routing40_driver.symbols',compiled):
            drive(ROOT,d,row,agent_impl=agent)
        self.assertEqual(seen,[Q])

    def test_unscoped_after_text_is_refused_without_sequence_or_broadcast(self):
        with S.turn(Q,presentation=True):pass
        response,seq,sent=route({'kind':'chart','data':[['January',10],['February',20]]})
        self.assertIsInstance(response,Response)
        self.assertEqual(response.status_code,409)
        self.assertEqual((seq,sent),(0,[]))

    def test_active_voice_publication_is_bound_and_secret_never_reaches_screen(self):
        with S.publisher('voice','a'*32) as publication:
            response,seq,sent=route({'kind':'widget','url':'https://widgets.example.test/example','publication':publication})
            self.assertEqual(response['ok'],True)
            self.assertEqual(seq,1)
            self.assertNotIn('publication',sent[0])
            self.assertNotIn(publication['token'],json.dumps(sent))
        response,seq,sent=route({'kind':'widget','publication':publication})
        self.assertEqual(response.status_code,409)
        self.assertEqual((seq,sent),(0,[]))

    def test_active_text_and_mode_spoofing_cannot_publish(self):
        with S.publisher('text','b'*32) as publication:
            for kind in ['chart','widget','text','clear']:
                response,seq,sent=route({'kind':kind,'mode':'voice','publication':publication})
                self.assertEqual(response.status_code,409)
                self.assertEqual((seq,sent),(0,[]))

    def test_wrong_token_wrong_chat_and_old_voice_turn_cannot_publish(self):
        with S.publisher('voice','c'*32) as first:
            for fields in [{'token':'0'*64},{'conv':'d'*32},{'turn':'0'*32}]:
                response,seq,sent=route({'kind':'text','publication':{**first,**fields}})
                self.assertEqual(response.status_code,409)
        with S.publisher('voice','c'*32):
            response,seq,sent=route({'kind':'text','publication':first})
            self.assertEqual(response.status_code,409)

    def test_nested_text_cannot_inherit_a_voice_grant(self):
        with S.publisher('voice','c'*32) as voice:
            with S.publisher('text','c'*32) as text:
                self.assertNotEqual(voice['turn'],text['turn'])
                self.assertFalse(S.artifact_allowed({'kind':'chart','publication':text}))
            self.assertEqual(S.publisher_context(),voice)

    def test_actual_publisher_uses_trusted_context_not_model_arguments(self):
        screen=screen_module();requests=[]
        def opened(req,**kwargs):
            requests.append(json.loads(req.data))
            return io.BytesIO(b'{"screens":1,"kind":"text"}')
        with S.publisher('voice','e'*32) as publication:
            with patch.dict(os.environ,{'JARVIS_SCREEN_PUBLICATION':json.dumps(publication)},clear=True),patch.object(screen,'_token',return_value='fixture-token'),patch('urllib.request.urlopen',opened):
                answer=json.loads(screen.screen_show({'kind':'text','text':'Answer','publication':{'token':'model'}}))
        self.assertTrue(answer['ok'])
        self.assertEqual(requests[0]['publication'],publication)
        with patch.dict(os.environ,{},clear=True),patch('urllib.request.urlopen') as http:
            self.assertIn('error',json.loads(screen.screen_show({'kind':'text','text':'late'})))
            http.assert_not_called()

    def test_warm_context_is_atomically_bound_and_reused_gate_fields_are_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'turn.json';path.write_text(json.dumps({'JARVIS_WEB_CHAT':'f'*32,'JARVIS_APPROVAL_SECRET':'fixture'}))
            with S.publisher('voice','f'*32) as publication:
                S.bind_publisher(path)
                content=json.loads(path.read_text())
                self.assertEqual(content['JARVIS_APPROVAL_SECRET'],'fixture')
                self.assertEqual(content['JARVIS_SCREEN_PUBLICATION'],publication)
                screen=screen_module()
                with patch.dict(os.environ,{'JARVIS_WEB_CTX':str(path)},clear=True):
                    self.assertEqual(screen._publication(),publication)

    def test_actual_cold_helper_passes_voice_grant_and_denies_text_grant(self):
        import subprocess
        actual_popen=subprocess.Popen
        for mode in ('voice','text'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as d:
                home=Path(d);binary=home/'hermes'
                binary.write_text('#!'+sys.executable+'\nimport json\nprint(json.dumps({"type":"result","text":"<<<SPOKEN Fixture answer. SPOKEN>>>"}))\n')
                binary.chmod(0o700)
                env=agent_environment(ROOT,home,binary)
                env.update(RESPONSE_AUTHORING=A,WARM_ENABLED=False)
                wrapped=A.agent_result(env['hermes_answer']);grants=[];children=[]
                def spawn(*args,**kwargs):
                    grant=json.loads(kwargs['env']['JARVIS_SCREEN_PUBLICATION']);grants.append(grant)
                    response,seq,sent=route({'kind':'text','text':'Fixture','publication':grant})
                    if mode=='voice':self.assertTrue(response['ok'])
                    else:self.assertEqual(response.status_code,409)
                    child=actual_popen(*args,**kwargs);children.append(child);return child
                with patch('subprocess.Popen',spawn):
                    status,text=wrapped('A fixture answer.',mode=mode,conv='a'*32)
                for child in children:
                    for pipe in (child.stdout,child.stderr):pipe.close()
                self.assertEqual((status,text),('ok','Fixture answer.'))
                self.assertEqual(len(grants),1)
                self.assertFalse(S.artifact_allowed({'kind':'text','publication':grants[0]}))

    def test_failed_authoring_cleans_completed_fallback_instead_of_leaking_json(self):
        def agent(prompt,mode='text',on_event=None):return 'ok','```ui\n{"type":"chart","data":[["A",10],["B",20]]}\n```'
        wrapped=A.agent_result(agent)
        with patch.dict(agent.__globals__,FRONT_MODEL='fixture',DS_KEY='fixture'),patch.object(A,'author',return_value=('failed',A.FAILED)):
            status,text=wrapped('Compare these choices.',mode='text')
        self.assertEqual(status,'ok')
        self.assertNotIn('"data"',text)
        self.assertNotIn('```',text)

    def test_declared_schema_is_exactly_unchanged(self):
        self.assertEqual(hashlib.sha256(L.prompt_note().encode()).hexdigest(),'4ccfbec465fd3fb2284d5f0e0c3147a71c81e1ac5377e9fa7956ba676c969b6e')


if __name__=='__main__':unittest.main()
