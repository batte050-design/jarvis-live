import unittest,sys,json,datetime
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT),str(ROOT/'tests')]
from authoring_agent_support import symbols
class ParityTests(unittest.TestCase):
 def test_machine_read_is_same_telemetry_source_and_reaches_model_history(self):
  calls=[]
  def stream(*a,**kw):calls.append(kw);yield 'ready'
  env=symbols(ROOT,['front_stream'],{'datetime':datetime,'OPENUI':SimpleNamespace(stream=stream),'FRONT_MODEL':'test','DS_KEY':'test','_telemetry':lambda:{'disk':{'free':123},'mem':{},'uptime':4},'for_model':lambda p:[x for x in p if x['role'] in ('user','assistant')], 'PUBLIC_LOOKUP':None})
  self.assertEqual(list(env['front_stream']('disk?',[],mode='text')),['ready'])
  history=calls[0]['history'];self.assertEqual(history[-1]['role'],'system');self.assertIn('123',history[-1]['content']);self.assertIn('hosting server',history[-1]['content'])
 def test_frozen_contract_covers_every_case_without_editing_questions(self):
  cases=json.loads((ROOT/'tests/fixtures/generative30.json').read_text())['cases'];c=json.loads((ROOT/'tests/fixtures/parity-contract.json').read_text());self.assertEqual(set(c['rules']),{x['id'] for x in cases});self.assertEqual(c['minimum_frozen_passes'],30);self.assertEqual(c['repeat_runs'],3)
if __name__=='__main__':unittest.main()
