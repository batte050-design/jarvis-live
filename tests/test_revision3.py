"""Real validator and worker regressions for service runtime and complete diagnostic paths."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import response_openui as O
from generative_evidence import cancellation_payload,summarise
from routing40_driver import drive
from authoring_agent_support import symbols,Response
from types import SimpleNamespace


class Revision3Tests(unittest.TestCase):
    def test_authenticated_service_preflight_reports_missing_validator_without_a_model_turn(self):
        env=symbols(ROOT,['openui_health'],{'OPENUI':O,'auth_scope':lambda r:r.scope,'same_origin':lambda r:r.same,'JSONResponse':Response,'_redact':SimpleNamespace(redact=str)})
        fn=env['openui_health']
        self.assertEqual(fn(SimpleNamespace(scope='voice',same=True)).status_code,403)
        self.assertEqual(fn(SimpleNamespace(scope='full',same=False)).status_code,403)
        with patch.dict(os.environ,{'PATH':'','JARVIS_OPENUI_NODE':''}):
            result=fn(SimpleNamespace(scope='full',same=True));self.assertEqual(result.status_code,503);self.assertIn('validator_runtime_missing',result.content['error'])
    def test_explicit_node_works_with_an_empty_service_path(self):
        node=O.validator_runtime()
        with patch.dict(os.environ,{'PATH':'','JARVIS_OPENUI_NODE':node}):
            self.assertEqual(O.validator_health()['components'],52)

    def test_missing_node_reports_runtime_error_without_paid_repair_attempts(self):
        calls=[];errors=[]
        def provider(*a):calls.append(1);yield {'content':'A useful answer.\n```openui\nroot = Col([Text("Ready")])\n```'}
        with patch.dict(os.environ,{'PATH':'','JARVIS_OPENUI_NODE':''}):
            answer=''.join(O.stream('An illustration','m','k',provider=provider,on_diagnostic=errors.append));diagnostics=[]
            status,text=O.finalize(answer,diagnostics)
        self.assertEqual(len(calls),1);self.assertEqual(status,'partial');self.assertIn('validator_runtime_missing',errors[0]['message']);self.assertTrue(diagnostics)

    def test_actual_worker_puts_missing_runtime_diagnostic_in_note_and_done(self):
        row={'q':'An illustration','web':'auto','memory':'on','web_behavior':'none','model_action':'answer','front_answer':'The finding.\n```openui\nroot = Col([Text("Ready")])\n```'}
        with patch.dict(os.environ,{'PATH':'','JARVIS_OPENUI_NODE':''}),tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):
            actual=drive(ROOT,folder,row)
        notes=[d for n,d in actual['events'] if n=='note'];done=next(d for n,d in actual['events'] if n=='done')
        self.assertTrue(any('validator_runtime_missing' in str(n.get('presentation_errors')) for n in notes))
        self.assertEqual(done['status'],'partial');self.assertTrue(done['presentation_errors']);self.assertTrue(done['presentation_diagnostics'])
        self.assertEqual(sum('The declared OpenUI program failed' in str(r) for r in actual['front_requests']),0)

    def test_provider_failure_before_a_fence_still_has_visible_diagnostics(self):
        diagnostics=[]
        def provider(*a):yield {'content':'Verified finding.\n'};raise TypeError('fixture stream fault')
        text=''.join(O.stream('question','m','k',provider=provider,on_diagnostic=diagnostics.append));reasons=[]
        self.assertEqual(O.finalize(text,reasons)[0],'partial');self.assertTrue(reasons);self.assertEqual(diagnostics[0]['phase'],'provider')

    def test_actual_captured_media_bill_and_supplied_chart_compile(self):
        captured=json.loads((ROOT/'tests/fixtures/r3-captured.json').read_text())
        for row in captured['rows']:
            with self.subTest(case=row['id']):self.assertEqual(O.finalize(row['answer'])[0],'ok',O.program_errors(row['answer']))

    def test_optional_null_is_a_default_slot_but_required_data_still_rejects(self):
        self.assertEqual(O.validate('root = Col([Row([Text("Number", "sm", null, "medium")], null, "center", "between")])',[])['components'],52)
        with self.assertRaises(ValueError):O.validate('root = Col([Text(null)])',[])
        with self.assertRaises(ValueError):O.validate('root = Col([Chart("bar", null)])',[])

    def test_cancel_without_numeric_turn_requires_verified_tid(self):
        request={'mode':'text','conv':'a'*32,'tid':'b'*16}
        self.assertIsNone(cancellation_payload(None,None));self.assertIsNone(cancellation_payload({},{}))
        self.assertIsNone(cancellation_payload({'conv':request['conv']},request))
        self.assertEqual(cancellation_payload({'conv':request['conv'],'tid':request['tid']},request),{'tid':'b'*16})

    def test_reasoning_and_null_continuation_tool_fragments_are_not_answer_text(self):
        calls=[]
        def provider(messages,*a):
            calls.append(messages)
            if len(calls)==1:
                yield {'reasoning_content':'HIDDEN','tool_calls':[{'index':0,'id':'read1','function':{'name':'web_search','arguments':''}}]}
                yield {'tool_calls':[{'index':0,'id':None,'function':{'name':None,'arguments':'{"query":"public fact"}'}}]}
            else:yield {'content':'The answer.'}
        text=''.join(O.stream('question','m','k',provider=provider,lookup=lambda *a:{'results':[]}))
        self.assertEqual(text,'The answer.');self.assertEqual(calls[1][-2]['reasoning_content'],'HIDDEN')

    def test_sse_metadata_overhead_is_not_mistaken_for_oversized_answer(self):
        payload={'choices':[{'delta':{'content':'A'}}],'metadata':'x'*600}
        wire=('data: '+json.dumps(payload)+'\n\n')*1000+'data: [DONE]\n\n'
        self.assertGreater(len(wire),O.LIMIT*4)
        with patch('urllib.request.urlopen',return_value=io.BytesIO(wire.encode())):
            self.assertEqual(''.join(d.get('content','') for d in O._provider([], 'm','k',[])),'A'*1000)

    def test_provider_aborted_finish_is_reported_instead_of_clean_success(self):
        wire='data: '+json.dumps({'choices':[{'delta':{'content':'A finding.\n'},'finish_reason':'aborted'}]})+'\n\ndata: [DONE]\n\n'
        diagnostics=[]
        with patch('urllib.request.urlopen',return_value=io.BytesIO(wire.encode())):
            text=''.join(O.stream('question','m','k',on_diagnostic=diagnostics.append))
        self.assertEqual(O.finalize(text)[0],'partial');self.assertEqual(diagnostics[0]['code'],'provider_finish_aborted')


if __name__=='__main__':unittest.main()
