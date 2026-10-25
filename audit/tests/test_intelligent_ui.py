"""Exercise real prompt-building code without importing the server or using credentials."""
import ast
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

from authoring_agent_support import symbols

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
SOURCE = (ROOT / 'server.py').read_text()
spec = importlib.util.spec_from_file_location('ui_response_layer', ROOT / 'response_layer.py')
LAYER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(LAYER)
import response_openui as OPENUI


def prompt_environment(source=SOURCE):
    tree = ast.parse(source)
    names = {'WORK_MARK','SYSTEM','TEXT_MODE_NOTE','TEXT_MECHANICS','VOICE_ONLY','FAMILIES','RESTRAINT','MECHANICS',
             'COMPOSE','SPOKEN_NOTE','UI_LIBRARY','UI_NOTE','NO_FILLER','NO_VOICE_LOSS','FORMAT_RULES'}
    env = {'re':re, 'RESPONSE_LAYER':LAYER,
           'WEB_NOTE':'SEARCH FIRST. ', 'NO_MEMORY_NOTE':'NO MEMORY. ',
           'thread_note':lambda conv:'THREAD '+str(conv)+'\n'}
    nodes = [n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id in names for t in n.targets)]
    nodes += [n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'system_for','route_format','shape_hint','format_directive'}]
    # Stop the real deep helper immediately after its prompt is built. No child, state or service.
    deep = next(n for n in tree.body if getattr(n,'name',None)=='hermes_answer')
    end = next(i for i,n in enumerate(deep.body) if isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='_guard_path')
    deep.body = deep.body[:end] + [ast.Return(ast.Name('ask',ast.Load()))]
    deep.decorator_list = []
    nodes.append(deep)
    module = ast.Module(body=nodes,type_ignores=[])
    ast.fix_missing_locations(module)
    exec(compile(module,'<actual prompt builders>','exec'),env)
    persona=ROOT/'persona/system.txt'
    if persona.is_file():env['SYSTEM']=persona.read_text()
    return env


class IntelligentUITests(unittest.TestCase):
    def test_fast_presentation_and_deep_findings_have_separate_consistent_roles(self):
        e=prompt_environment()
        for question in ['Show me buildings.', 'Explain how an engine works.', 'Price four jobs at 80,000 UGX each.']:
            findings=e['hermes_answer'](question,mode='text')
            self.assertIn('separate text presenter',findings)
            self.assertIn('Do not author UI JSON',findings)
            self.assertNotIn(LAYER.prompt_note(),findings)
        prompt=OPENUI.system_prompt()
        for primitive in ['Col(', 'Image(', 'Slider(', 'Popover(', 'Form(']:self.assertIn(primitive,prompt)
        self.assertIn('You choose how to answer EACH text question',prompt)
        self.assertIn('ordinary prose',prompt)
        self.assertIn('retrieval',prompt)

    def test_actual_fast_request_receives_the_new_policy_without_extra_provider_call(self):
        import response_authoring
        e = prompt_environment()
        e.update(OPENUI=OPENUI,RESPONSE_AUTHORING=response_authoring,FRONT_MODEL='fixture',DS_KEY='fixture',
                 identity=lambda:'',recall=lambda:[],for_model=lambda rows:rows,now_line=lambda:'clock')
        env = symbols(ROOT,['front_stream'],e)
        seen = []
        def opened(request,**kwargs):
            seen.append(json.loads(request.data))
            return io.BytesIO(b'data: {"choices":[{"delta":{"content":"7,300,000 UGX."}}]}\n\ndata: [DONE]\n')
        with patch('urllib.request.urlopen',opened):
            text = ''.join(env['front_stream']('How much would I save at 20,000 UGX a day for a year?',mode='text'))
        self.assertEqual(text,'7,300,000 UGX.')
        self.assertEqual(len(seen),1)
        self.assertIn(OPENUI.system_prompt(),seen[0]['messages'][0]['content'])
        self.assertEqual(seen[0]['messages'][-1]['content'],'How much would I save at 20,000 UGX a day for a year?')

    def test_deep_text_owns_inline_presentation_and_keeps_requested_files(self):
        text = prompt_environment()['hermes_answer']('Show me buildings.',mode='text')
        self.assertIn('Do not author UI JSON, HTML, screen_show calls',text)
        self.assertNotIn('run its check command on that file with a short label',text)
        self.assertIn('When a downloadable file was explicitly requested',text)
        self.assertIn('[[file:name]]',text)

    def test_voice_prompts_and_declarative_schema_match_the_pinned_baseline(self):
        fixture = json.loads((ROOT/'tests/fixtures/ui_voice_baseline.json').read_text())
        e = prompt_environment()
        values = {
            'format':e['format_directive']('compare','voice'),
            'deep':e['hermes_answer']('Compare these options.',mode='voice',web=True,memory=False,conv='fixture'),
            'schema':LAYER.prompt_note(),
        }
        if (ROOT/'persona/system.txt').is_file():values['system']=e['system_for']('voice')
        else:print('SKIP private-persona voice-system hash: persona is intentionally excluded from the public snapshot')
        self.assertEqual(e['shape_hint']('voice','question'),'')
        for name,value in values.items():
            self.assertEqual(hashlib.sha256(value.encode()).hexdigest(),fixture['sha256'][name],name)


if __name__ == '__main__':
    unittest.main()
