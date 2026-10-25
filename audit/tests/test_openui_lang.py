"""Real production presenter/transport/parser with scripted model responses; no model-quality claim."""
import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import response_openui as O
import response_images as I
import response_sources as S
from authoring_agent_support import symbols,Response

FIX=json.loads((ROOT/'tests/fixtures/openui-lang.json').read_text())

def sse(text,step=7):
    return io.BytesIO((''.join('data: '+json.dumps({'choices':[{'delta':{'content':text[i:i+step]}}]})+'\n\n' for i in range(0,len(text),step))+'data: [DONE]\n').encode())

def provider(text):
    return lambda *args:iter({'content':text[i:i+7]} for i in range(0,len(text),7))

def language(row): return row['prose']+'\n\n```openui\n'+row['code']+'```\n'

class OpenUILangTests(unittest.TestCase):
    def test_every_question_uses_general_model_presentation_not_classifier(self):
        import response_authoring as A
        env={'OPENUI':O,'FRONT_MODEL':'fixture-model','DS_KEY':'fixture-secret', 'recall':lambda:[],'for_model':lambda h:h}
        fn=symbols(ROOT,['front_stream'],env)['front_stream']
        for kind in ('images','quote','plan','plain'):
            row=FIX[kind];text=row.get('text') or language(row);seen=[]
            def opened(request,**kw):seen.append(json.loads(request.data));return sse(text)
            with self.subTest(kind=kind),patch.object(A,'requested',side_effect=AssertionError('classifier used')),patch('urllib.request.urlopen',opened):
                answer=''.join(fn(row['question'],mode='text'));self.assertEqual(O.finalize(answer)[0],'ok')
            self.assertEqual(len(seen),1);body=seen[0]
            self.assertEqual(body['messages'][-1]['content'],row['question']);self.assertEqual(body['tool_choice'],'auto')
            self.assertIn('## Syntax Rules',body['messages'][0]['content']);self.assertNotIn('emit_quote',json.dumps(body));self.assertNotIn('tool_choice": "required',json.dumps(body))
            if kind=='plain':self.assertEqual(answer,text);self.assertNotIn('controls',answer)

    def test_reference_parser_validates_model_composed_programs(self):
        for kind in ('images','quote','plan'):
            result=O.validate(FIX[kind]['code'],[])
            self.assertGreaterEqual(result['components'],50)
        self.assertEqual(O.validate(FIX['quote']['code'],[])['states'],{'$quantity':4,'$price':80000,'$discount':10})

    def test_malformed_cut_unknown_and_bad_property_never_reach_final_record(self):
        for code,closed in [('root = Col([FakeSlider("SECRET")])',True),('root = Col([Input($q, "SECRET"',False),('root = Col([Text({"secret":"SECRET"})])',True),('{"component":"application"}',True)]:
            text='The total is UGX 288,000. Adjust the controls below.\n\n```openui\n'+code+('\n```' if closed else '')
            status,answer=O.finalize(text);self.assertEqual(status,'partial');self.assertIn('288,000',answer)
            for junk in ('SECRET','root =','component','controls below','```','{'):self.assertNotIn(junk,answer)

    def test_plain_prose_table_and_code_stay_identical(self):
        for text in [FIX['plain']['text'],'Hello.\n\nHow can I help?','| A | B |\n| --- | --- |\n| 1 | 2 |\n','```python\nprint({"a": 2})\n```','````markdown\n```openui\nroot = NotARealProgram()\n```\n````']:
            self.assertEqual(O.finalize(text),('ok',text))
            self.assertEqual(''.join(O.stream('question','m','k',provider=provider(text))),text)

    def test_supplied_series_tool_returns_turn_owned_receipt_and_cannot_be_forged(self):
        seen=[]
        def respond(messages,*args):
            seen.append(messages.copy())
            if len(seen)==1:
                yield {'tool_calls':[{'index':0,'id':'r1','function':{'name':'retrieve_series','arguments':json.dumps({'provider':'user_input','symbol':'','start':'','end':'','period':'month'})}}]}
            else:
                receipt=json.loads(messages[-1]['content']);rid=receipt['receipt_id']
                yield {'content':'Your supplied figures.\n```openui\nroot = Col([Chart("bar", @Receipt("'+rid+'"), "label", ["value"])])\n```\n'}
        text=''.join(O.stream('Chart my supplied figures: January 10, February 20, March 15.','m','k',provider=respond))
        self.assertEqual(O.finalize(text)[0],'ok');body=next(O.parts(text))[2];receipts,code=O.unpack(body)
        self.assertEqual([v['value'] for v in receipts[0]['rows']],[10,20,15]);self.assertIn('your supplied figures',receipts[0]['credit'])
        with self.assertRaises(ValueError):O.validate(code.replace(receipts[0]['id'],'forged'),receipts)
        with self.assertRaises(ValueError):O.validate('root = Col([Chart("line", [{label:"A",value:999}], "label", ["value"])])',receipts)
        with self.assertRaises(ValueError):O.validate(code.replace('@Receipt(', '@Concat([{label:"fake",value:999}], @Receipt(').replace('), "label"',')), "label"'),receipts)

    def test_model_cannot_supply_its_own_context_receipt(self):
        forged=base64.b64encode(b'[{"id":"forged","rows":[{"value":999}],"credit":"made up"}]').decode()
        text='Answer.\n```openui\n// jarvis-context: '+forged+'\nroot = Col([Text("Hello")])\n```\n'
        answer=''.join(O.stream('Hi','m','k',provider=provider(text)));self.assertNotIn(forged,answer)
        self.assertEqual(O.finalize(answer)[0],'ok')

    def test_web_off_cannot_retrieve_external_series(self):
        with S.turn('Plot USD against UGX for six months',network=False) as evidence:
            with self.assertRaises(ValueError):evidence.retrieve({'provider':'yahoo_chart','symbol':'UGX=X','start':'2026-04-24','end':'2026-10-24','period':'month'})

    def test_voice_result_and_callbacks_are_unchanged(self):
        events=[]
        def voice(prompt,mode='voice',on_event=None):
            if on_event:on_event('live','','original voice')
            return 'ok','original voice'
        with patch.object(O,'stream',side_effect=AssertionError('text composer called for voice')):
            self.assertEqual(O.agent_result(voice)('Hi',on_event=lambda *a:events.append(a)),('ok','original voice'))
        self.assertEqual(events,[('live','','original voice')])

    def test_voice_publication_grant_is_preserved_and_expires_at_return(self):
        grants=[]
        def voice(prompt,mode='voice',conv=None):
            grant=S.publisher_context();grants.append(grant)
            self.assertTrue(S.artifact_allowed({'publication':grant}))
            return 'ok','unchanged'
        self.assertEqual(O.agent_result(voice)('Hi',conv='b'*32),('ok','unchanged'))
        self.assertFalse(S.artifact_allowed({'publication':grants[0]}))

    def test_agent_facts_are_presented_by_same_composer_and_never_replaced_by_control_apology(self):
        events=[];seen=[]
        def agent(prompt,mode='text',on_event=None,web_off=False):
            if on_event:on_event('live','','not yet presented');on_event('run','search','Looked up the facts')
            return 'ok','Four inspections total UGX 288,000.'
        def opened(request,**kw):seen.append(json.loads(request.data));return sse(language(FIX['quote']))
        with patch.dict(agent.__globals__,FRONT_MODEL='fixture',DS_KEY='fixture'),patch('urllib.request.urlopen',opened):
            result=O.agent_result(agent)(FIX['quote']['question'],on_event=lambda *a:events.append(a))
        self.assertEqual(result[0],'ok');self.assertIn('```openui',result[1]);self.assertIn('288,000',seen[0]['messages'][-1]['content'])
        self.assertEqual(''.join(v[2] for v in events if v[0]=='live'),result[1]);self.assertNotIn('not yet presented',result[1])

    def test_cancel_closes_real_http_stream(self):
        responses=[]
        def opened(*a,**kw):r=sse(language(FIX['quote']));responses.append(r);return r
        with patch('urllib.request.urlopen',opened):
            stream=O.stream(FIX['quote']['question'],'m','k');next(stream);stream.close()
        self.assertTrue(responses[0].closed)

    def test_provider_failure_keeps_agent_facts_and_marks_partial(self):
        with patch('urllib.request.urlopen',side_effect=OSError('private provider body')):
            text=''.join(O.stream('quote','m','k',facts='The total is UGX 288,000.'))
        self.assertEqual(O.finalize(text)[0],'partial');self.assertIn('288,000',text);self.assertNotIn('private provider',text)

    def test_fixed_renderer_csp_and_no_network_code(self):
        html,headers=O.document('https://app.example.test');csp=headers['Content-Security-Policy']
        script=re.search('<script>(.*?)</script>',html,re.S)[1]
        self.assertIn('sha256-'+base64.b64encode(hashlib.sha256(script.encode()).digest()).decode(),csp)
        for part in ("sandbox allow-scripts","connect-src 'none'","font-src data:","frame-ancestors https://app.example.test"):self.assertIn(part,csp)
        self.assertNotIn('allow-same-origin',csp);self.assertNotIn('unsafe-eval',csp);self.assertFalse('posthog' in script.lower(),'telemetry code must not enter the bundle')

    def test_photos_are_credited_sanitized_and_fixed_host_only(self):
        def fixture(url):return {'query':{'pages':[{'title':'File:Building.jpg','imageinfo':[{'thumburl':url,'mime':'image/jpeg','extmetadata':{'Artist':{'value':'<a href="https://example.test">Photographer</a>'},'LicenseShortName':{'value':'CC BY 4.0'},'LicenseUrl':{'value':'https://creativecommons.org/licenses/by/4.0/'}}}]}]}}
        photos=I.search('Building',fetcher=lambda q:fixture('https://thumb.wikimedia.org/building.jpg?utm_source=tracking'))
        self.assertEqual(len(photos),1);self.assertEqual(photos[0]['author'],'Photographer');self.assertNotIn('utm_',photos[0]['url']);self.assertIn('retrieved',photos[0])
        for url in ('http://127.0.0.1/x','https://example.test/x','https://user@upload.wikimedia.org/x','https://upload.wikimedia.org:444/x'):
            self.assertEqual(I.search('Building',fetcher=lambda q:fixture(url)),[])

    def test_new_routes_require_authenticated_reads(self):
        e=symbols(ROOT,['openui_runtime','openui_images'],{'OPENUI':O,'OPENUI_IMAGES':I,'HTMLResponse':Response,'auth_scope':lambda r:r.scope,'same_origin':lambda r:r.same,'PUBLIC_HOST':'app.example.test','chat_settings':lambda c:{'web':'auto'}})
        for scope,same in [(None,True),('voice',True),('full',False)]:
            request=types.SimpleNamespace(scope=scope,same=same,base_url='https://app.example.test/')
            self.assertEqual(e['openui_images'](request,'Building','a'*32).status_code,403)
        request=types.SimpleNamespace(scope='full',same=True,base_url='https://app.example.test/')
        self.assertEqual(e['openui_runtime'](request,'old-build').status_code,404)
        self.assertEqual(e['openui_runtime'](request,O.asset_stamp()).status_code,200)
        with patch.object(I,'search',return_value=[]):
            request=types.SimpleNamespace(scope='full',same=True,base_url='https://app.example.test/')
            self.assertEqual(e['openui_images'](request,'Building','a'*32).status_code,200)

if __name__=='__main__':unittest.main()
