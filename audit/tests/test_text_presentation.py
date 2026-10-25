"""Mechanism regressions. Scripted model/web boundaries; not model-quality evidence."""
import io
import json
from pathlib import Path
import sys
import os
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import response_openui as O
import response_lookup as L
from authoring_agent_support import symbols,Response


def fence(code):return 'Useful answer.\n```openui\n'+code+'\n```\n'
def tool(name,args):return {'tool_calls':[{'index':0,'id':'read1','function':{'name':name,'arguments':json.dumps(args)}}]}
def collect(provider,**kw):
    value='';updates=[]
    for item in O.stream('A general request','model','secret',provider=provider,**kw):
        value=str(item) if isinstance(item,O.Replacement) else value+item
        updates.append(item)
    return value,updates


class PresentationTests(unittest.TestCase):
    def test_repairs_replace_instead_of_append_and_keep_source_metadata(self):
        seen=[]
        def provider(messages,*args):
            seen.append(messages)
            yield {'content':fence('root = Col([UnknownThing("SECRET")])' if len(seen)==1 else 'root = Col([Text("Repaired answer")])')}
        text,events=collect(provider)
        self.assertEqual(len(seen),2)
        self.assertEqual(sum(isinstance(v,O.Replacement) for v in events),1)
        self.assertEqual(text.count('```openui'),1)
        self.assertNotIn('SECRET',text)
        self.assertTrue(O.unpack(next(O.parts(text))[2])[0])
        self.assertEqual(O.finalize(text)[0],'ok')
        self.assertIn('UnknownThing',seen[1][-1]['content'])

    def test_truncated_program_uses_same_bounded_repair(self):
        calls=[]
        def provider(*args):
            calls.append(1)
            yield {'content':'The useful fact.\n```openui\nroot = Col([Text("cut' if len(calls)==1 else 'root = Col([Text("Whole")])'}
        text,_=collect(provider)
        self.assertEqual(len(calls),2);self.assertEqual(O.finalize(text)[0],'ok')

    def test_repair_preserves_prose_between_blocks_and_discards_repair_chatter(self):
        calls=[]
        def provider(*args):
            calls.append(1)
            yield {'content':fence('root = Bad()')+'Middle fact.\n'+fence('root = Bad()') if len(calls)==1 else 'UNREQUESTED CHATTER\n'+fence('root = Col([Text("Fixed")])')}
        text,_=collect(provider)
        self.assertEqual(text.count('```openui'),1);self.assertIn('Middle fact.',text);self.assertNotIn('UNREQUESTED CHATTER',text)

    def test_two_rejected_repairs_keep_readable_text_without_payload_or_apology(self):
        calls=[]
        def provider(*args):calls.append(1);yield {'content':fence('root = Bad("SECRET")')}
        text,_=collect(provider);status,text=O.finalize(text)
        self.assertEqual(len(calls),3);self.assertEqual(status,'partial');self.assertEqual(text,'Useful answer.')

    def test_valid_supplied_chart_is_not_repaired_for_missing_injected_receipt(self):
        calls=[]
        def provider(messages,*args):
            calls.append(messages)
            if len(calls)==1:yield tool('retrieve_series',{'provider':'user_input','symbol':'','start':'','end':'','period':'month'})
            else:
                rid=json.loads(messages[-1]['content'])['receipt_id']
                yield {'content':fence('root = Col([Chart("bar", @Receipt("'+rid+'"), "label", ["value"])])')}
        answer=''
        for x in O.stream('Chart only supplied data: Red 2; Blue 3; Green 4','m','k',provider=provider):answer+=x
        self.assertEqual(len(calls),2);self.assertEqual(O.finalize(answer)[0],'ok')

    def test_public_lookup_returns_dated_sources_without_task_engine(self):
        seen=[];reads=[];events=[]
        def provider(messages,*args):
            seen.append(messages)
            yield tool('web_search',{'query':'public source'}) if len(seen)==1 else {'content':'The sourced answer.'}
        def lookup(name,args):reads.append((name,args));return {'results':[{'url':'https://example.test/source','text':'Evidence'}]}
        text,_=collect(provider,lookup=lookup,on_event=lambda *x:events.append(x),require_web=True)
        self.assertEqual(text,'The sourced answer.');self.assertEqual(len(reads),1)
        result=json.loads(seen[-1][-1]['content']);self.assertIn('retrieved',result)
        self.assertEqual([v[0] for v in events],['run','ok'])

    def test_always_does_not_commit_unsupported_claim_when_provider_ignores_lookup(self):
        with self.assertRaisesRegex(ValueError,'No complete answer'):
            collect(lambda *a:iter([{'content':'Unsupported claim.'}]),require_web=True,lookup=lambda *a:{})

    def test_guarded_tasks_are_explicit_model_tool_calls(self):
        with self.assertRaises(O.RequestWork):collect(lambda *a:iter([tool('request_task',{'kind':'private_read','purpose':'Read my account'})]))
        text,_=collect(lambda *a:iter([{'content':'Show and compare prices inline.'}]))
        self.assertEqual(text,'Show and compare prices inline.')

    def test_web_off_omits_public_tools_and_cannot_dispatch_them(self):
        seen=[];lookups=[]
        def provider(messages,model,key,tools):
            seen.append(tools)
            yield tool('web_search',{'query':'unavailable'}) if len(seen)==1 else {'content':'No current evidence.'}
        collect(provider,network=False,lookup=lambda *a:lookups.append(a))
        self.assertFalse(lookups);self.assertNotIn('web_search',json.dumps(seen[0]))

    def test_reasoning_continuity_is_internal(self):
        seen=[]
        def provider(messages,*args):
            seen.append(messages)
            if len(seen)==1:
                yield {'reasoning_content':'HIDDEN_REASONING'};yield tool('web_search',{'query':'public source'})
            else:yield {'content':'Visible answer.'}
        text,_=collect(provider,lookup=lambda *a:{})
        self.assertEqual(text,'Visible answer.');self.assertEqual(seen[1][-2]['reasoning_content'],'HIDDEN_REASONING')

    def test_public_bridge_rejects_other_tools_extra_arguments_and_private_targets(self):
        for name,args in [('terminal',{'command':'id'}),('web_search',{'query':'ok','shell':'id'}),('web_extract',{'urls':['http://example.test']}),('web_extract',{'urls':['https://127.0.0.1']}),('web_extract',{'urls':['https://user@example.test']})]:
            with self.subTest(name=name,args=args),self.assertRaises(ValueError):L.arguments(name,args)
        with patch('socket.getaddrinfo',return_value=[(0,0,0,'',('10.0.0.1',443))]):
            with self.assertRaises(ValueError):L.public_url('https://example.test')

    def test_bridge_dispatches_only_fixed_public_functions_in_engine_interpreter(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'bin').mkdir();(root/'tools').mkdir();(root/'tools/__init__.py').write_text('')
            (root/'tools/web_tools.py').write_text('import json\ndef web_search_tool(query,limit=5): return json.dumps({"results":[{"query":query,"limit":limit}]})\nasync def web_extract_tool(urls): return {"pages":urls}\n')
            engine=root/'bin/hermes';engine.write_text('#!'+sys.executable+'\n')
            (root/'bin/python').symlink_to(sys.executable)
            with patch.dict(os.environ,PYTHONPATH=str(root)):
                result=L.run(engine,'web_search',{'query':'public example'})
                self.assertEqual(result['results'][0],{'query':'public example','limit':5})
                with self.assertRaisesRegex(ValueError,'cancelled'):L.run(engine,'web_search',{'query':'public example'},stop=lambda:True)

    def test_runtime_binds_frame_to_request_origin_on_stage_live_and_localhost(self):
        env=symbols(ROOT,['openui_runtime'],{'OPENUI':O,'HTMLResponse':Response,'auth_scope':lambda r:'full'})
        for origin in ['https://stage.battemohammad.com','https://live.battemohammad.com','http://127.0.0.1:8150']:
            result=env['openui_runtime'](types.SimpleNamespace(base_url=origin+'/'),O.asset_stamp())
            self.assertIn('frame-ancestors '+origin,result.headers['Content-Security-Policy'])
            self.assertIn(json.dumps({'parentOrigin':origin}),result.content)

    def test_failed_provider_retains_facts_and_honest_partial(self):
        def provider(*a):raise OSError('PRIVATE_ERROR');yield
        text,_=collect(provider,facts='The confirmed total is 42.')
        self.assertEqual(O.finalize(text)[0],'partial');self.assertIn('42',text);self.assertNotIn('PRIVATE_ERROR',text)

    def test_generic_policy_has_reference_composition_and_no_topic_router(self):
        text=O.system_prompt()
        for word in ['missing essential details','SVG','SearchImage','@ToAssistant','requested sentence count']:self.assertIn(word,text)
        self.assertFalse(hasattr(O,'_has_input'))


if __name__=='__main__':unittest.main()
