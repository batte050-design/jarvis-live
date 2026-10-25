"""Actual authoring/compiler/validator, with scripted provider boundaries; no paid model calls."""
import ast
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT=Path(os.environ.get('JARVIS_TEST_ROOT',Path(__file__).resolve().parents[1]))
sys.path.insert(0,str(ROOT))
import response_authoring as A
import response_layer as L
import response_sources as S
from authoring_agent_support import symbols

Q='help me price a job: four inspections at 80,000 each, 10% off, I want to adjust it'
CASES=json.loads((ROOT/'tests/fixtures/openui-cases.json').read_text())


def client(spec):
    p=subprocess.run(['node','-e',"const c=require('./static/response-core.js')(require('./response-capabilities.json')); console.log(JSON.stringify(c.validate(JSON.parse(require('fs').readFileSync(0)))));"],cwd=ROOT,input=json.dumps(spec),text=True,capture_output=True)
    if p.returncode:raise AssertionError(p.stderr)
    return json.loads(p.stdout)


def provider(arguments,seen):
    def opened(req,**kwargs):
        body=json.loads(req.data);seen.append(body)
        raw=json.dumps(arguments);frames=[]
        for i in range(0,len(raw),19):
            fn={'arguments':raw[i:i+19]}
            if i==0:fn['name']='emit_composition'
            frames.append({'choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'type':'function','function':fn}]}}]})
        frames.append({'choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]})
        return io.BytesIO((''.join('data: '+json.dumps(f)+'\n\n' for f in frames)+'data: [DONE]\n').encode())
    return opened


class OpenUIIntegration(unittest.TestCase):
    def emit(self,which='quote'):
        with S.turn(Q if which=='quote' else 'Plan a quiet afternoon.'):
            return A.emit('emit_composition',copy.deepcopy(CASES[which]))

    def test_the_natural_quote_uses_primitive_controls_on_both_lanes(self):
        for question in [Q,'Four inspections at UGX 80,000 each, 10% discount. Let me change the numbers.',
                         'Help me price a job: four inspections at UGX 80,000 each, with a 10% discount. Let me adjust the figures.']:
            self.assertEqual(A.requested(question),'emit_quote')
            with S.turn(question):
                spec=A.emit('emit_quote',{'title':'Inspections','currency':'UGX','quantity':4,'unit_price':80000,'discount_percent':10})
            self.assertEqual(spec['initial'],{'quantity':4,'price':80000,'discount':1000})
            self.assertIn('Form',[n['kind'] for n in spec['layout']])
            self.assertTrue(client(spec)['ok'])

    def test_model_composed_quote_has_live_graph_and_is_not_a_fixed_template(self):
        spec=self.emit();r=client(spec)
        self.assertTrue(r['ok'],r.get('reason'));self.assertEqual(spec['component'],'application')
        self.assertIn('Grid',[n['kind'] for n in spec['layout']]);self.assertIn('Popover',[n['kind'] for n in spec['layout']])
        code="const c=require('./static/response-core.js')(require('./response-capabilities.json'));let r=c.validate(JSON.parse(require('fs').readFileSync(0)));let s=c.initial(r.spec,{});s.quantity=5;console.log(c.evaluate(r.spec,s).total)"
        p=subprocess.run(['node','-e',code],cwd=ROOT,input=json.dumps(spec),text=True,capture_output=True)
        self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(p.stdout.strip(),'360000')

    def test_qualitative_plan_is_a_timeline_and_carousel_without_fake_data(self):
        spec=self.emit('plan');self.assertTrue(client(spec)['ok'])
        self.assertTrue({'Timeline','Carousel','Card'} <= {n['kind'] for n in spec['layout']})
        self.assertEqual(spec['inputs'],[])

    def test_text_date_select_checkbox_and_local_button_share_the_existing_state(self):
        spec=self.emit('preferences');self.assertTrue(client(spec)['ok'])
        kinds={n['kind'] for n in spec['layout']}
        self.assertTrue({'TextArea','DatePicker','Select','Checkbox','Button'} <= kinds)
        self.assertEqual(spec['actions'][0]['class'],'LOCAL')

    def test_actual_provider_stream_is_buffered_until_one_valid_declaration(self):
        seen=[];chunks=[]
        with S.turn(Q),patch('urllib.request.urlopen',provider(CASES['quote'],seen)):
            gen=A.author_chunks(Q,[{'role':'user','content':Q}],'fixture','fixture')
            try:
                while True:chunks.append(next(gen))
            except StopIteration as done:status,text=done.value
        self.assertEqual(status,'ok',text);self.assertTrue(all(c=='' for c in chunks))
        self.assertEqual(len(seen),1);self.assertIn('emit_composition',[t['function']['name'] for t in seen[0]['tools']])
        self.assertEqual(text.count('```ui'),1)
        self.assertTrue(client(json.loads(text.split('```ui\n')[1].split('\n```')[0]))['ok'])

    def test_actual_front_helper_receives_composition_tool_without_an_extra_turn(self):
        seen=[];env={'RESPONSE_AUTHORING':A,'FRONT_MODEL':'fixture','DS_KEY':'fixture','identity':lambda:'',
            'system_for':lambda mode:'fixed','recall':lambda:[],'for_model':lambda x:x,'now_line':lambda:'clock','shape_hint':lambda *a:''}
        fn=symbols(ROOT,['front_stream'],env)['front_stream']
        with patch('urllib.request.urlopen',provider(CASES['quote'],seen)):
            text=''.join(fn(Q,mode='text'))
        self.assertEqual(len(seen),1);self.assertIn('"layout"',text)

    def test_bad_compositions_never_escape_as_raw_payload(self):
        args=copy.deepcopy(CASES['quote']);args['layout'][0]['children'].append('missing')
        with S.turn(Q),patch('urllib.request.urlopen',provider(args,[])):
            status,text=A.author(Q,[],'fixture','fixture')
        self.assertEqual(status,'failed');self.assertNotIn('"layout"',text);self.assertNotIn('```',text)

    def test_cycles_orphans_duplicates_wrong_bindings_and_dead_controls_reject(self):
        for mode in ['cycle','orphan','duplicate','wrong-type','dead','missing-output','injection']:
            args=copy.deepcopy(CASES['quote'])
            if mode=='cycle':args['layout'][0]['children'].append('root')
            if mode=='orphan':args['layout'].append({**args['layout'][-1],'id':'orphan'})
            if mode=='duplicate':args['layout'].append(copy.deepcopy(args['layout'][-1]))
            if mode=='wrong-type':args['layout'][4]['kind']='Checkbox'
            if mode=='dead':args['graph']=[];args['outputs']=[{'kind':'text','value':'No calculation.'},{'kind':'text','value':'No calculation.'}]
            if mode=='missing-output':args['layout'][9]['children']=[];args['layout'].pop()
            if mode=='injection':args['layout'][0]['onclick']='alert(1)'
            with self.subTest(mode=mode),S.turn(Q):
                with self.assertRaises((ValueError,KeyError)):A.emit('emit_composition',args)
            raw={'type':'widget','component':'application','version':1,'id':'bad','props':{'title':args['title'],'currency':'UGX'},**{k:args[k] for k in ('inputs','graph','outputs','actions','layout','fallback')}}
            self.assertFalse(client(raw)['ok'],mode)

    def test_invented_price_and_numeric_output_are_denied(self):
        for change in ['price','output','narrative','nested-narrative']:
            args=copy.deepcopy(CASES['quote'])
            if change=='price':args['inputs'][1]['default']=99999
            elif change=='output':args['outputs'][0]['items'][0]['value']=99999
            elif change=='narrative':args['layout'][1]['text']='Guaranteed profit 99999'
            else:args['outputs'][0]['items'][0].update(value='Guaranteed profit 99999',format='text')
            with self.subTest(change=change),S.turn(Q):
                with self.assertRaises(ValueError):A.emit('emit_composition',args)

    def test_composition_cannot_bypass_the_receipt_path_with_a_chart(self):
        args=copy.deepcopy(CASES['plan']);args['outputs']=[{'kind':'chart','chart':'line','points':[{'label':'April','value':3700}]}]
        with S.turn(Q):
            with self.assertRaises(ValueError):A.emit('emit_composition',args)

    def test_a_truncated_or_invalid_declaration_cannot_settle_ok(self):
        for tail in ['```ui\n', '```ui\n'+json.dumps({'type':'widget','component':'application','version':1,'layout':[]})+'\n```']:
            def helper(prompt,mode='text',on_event=None):return 'ok','The total is UGX 288,000. Adjust the figures below.\n'+tail
            status,text=A.agent_result(helper)('A free-form answer.',mode='text')
            self.assertEqual(status,'partial');self.assertNotIn('Adjust',text);self.assertNotIn('"layout"',text)
        @A.text_stream
        def front(prompt,mode='text'):yield '```ui\n'
        with self.assertRaises(RuntimeError):list(front('Answer.',mode='text'))

    def test_painter_engine_and_voice_schema_are_exactly_the_base(self):
        hashes=json.loads((ROOT/'tests/fixtures/openui-baseline.json').read_text());sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
        painter=re.sub(r'/\* response-assets: [0-9a-f]+ \*/','',(ROOT/'static/v1.js').read_text())
        self.assertEqual(sha(painter),hashes['painter'])
        inline=json.dumps(re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',(ROOT/'index_v1.html').read_text(),re.S))
        self.assertEqual(sha(inline),hashes['inline']);self.assertEqual(sha(L.prompt_note()),hashes['voice_schema'])

    def test_ordinary_questions_stay_on_the_original_path(self):
        for q in ['Hello Jarvis.','What is 7 times 8?','Explain the difference between RAM and storage.','Give me a Python function.','Show these figures in a table.']:
            self.assertIsNone(A.requested(q),q)
        self.assertEqual(A.requested('Plan a quiet afternoon with a timeline.'),'auto')


if __name__=='__main__':unittest.main()
