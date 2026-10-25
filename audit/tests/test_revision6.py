import unittest,sys,json,io
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
import response_images as I
import response_openui as O
PHOTO={'title':'File:Subject.jpg','imageinfo':[{'thumburl':'https://upload.wikimedia.org/subject.jpg','mime':'image/jpeg','extmetadata':{'Artist':{'value':'Photographer'},'LicenseShortName':{'value':'CC BY 4.0'},'LicenseUrl':{'value':'https://creativecommons.org/licenses/by/4.0/'}}}]}
class BrokerFallbackTests(unittest.TestCase):
 def test_retry_preserves_subject_and_removes_only_trailing_presentation(self):
  for original,subject in [('ZZ plant Zamioculcas zamiifolia potted houseplant','ZZ plant Zamioculcas zamiifolia'),('golden pothos Epipremnum aureum hanging plant','golden pothos Epipremnum aureum'),('spider plant Chlorophytum comosum in a hanging pot','spider plant Chlorophytum comosum'),('peace lily Spathiphyllum in a pot with white flower','peace lily Spathiphyllum')]:
   calls=[];diagnostics=[]
   def fetch(p):calls.append(p['gsrsearch']);return {'query':{'pages':[] if len(calls)==1 else [PHOTO]}}
   self.assertEqual(len(I.search(original,fetch,diagnostics=diagnostics)),1);self.assertEqual(calls,[original+' filetype:bitmap',subject+' filetype:bitmap']);self.assertEqual([d['candidates'] for d in diagnostics],[0,1])
 def test_no_arbitrary_entity_truncation_and_two_request_bound(self):
  calls=[]
  def empty(p):calls.append(p);return {'query':{'pages':[]}}
  self.assertEqual(I.search('New York Times headquarters',empty),[]);self.assertEqual(len(calls),1)
  calls.clear();self.assertEqual(I.search('Subject photograph potted',empty),[]);self.assertEqual(len(calls),2)
 def test_license_guard_survives_retry(self):
  import copy
  p=copy.deepcopy(PHOTO);p['imageinfo'][0]['extmetadata'].pop('LicenseShortName');calls=[]
  def fetch(x):calls.append(x);return {'query':{'pages':[p]}}
  self.assertEqual(I.search('Subject potted',fetch),[]);self.assertEqual(len(calls),2)
class DerivedCompilerTests(unittest.TestCase):
 def test_recovered_live_fuel_expression_becomes_reactive_alias(self):
  p=json.loads((ROOT/'tests/fixtures/r6-derived-live.json').read_text())['program'];v=O.validate(p['code'],p['receipts']);self.assertEqual(v['formulaStates'],['$economy','$oneWay','$price','$trip']);self.assertNotIn('$cost =',v['canonicalCode'])
 def test_preserve_quotes_comments_keys_and_collisions(self):
  code='$x = 3\n$derived = $x * 2\n_jarvisDerived0 = 7\nroot = Col([Text("$derived"), Text(@Format($derived)), Text(@Format($x > 0 ? $derived : 0)), Text(@Format({$derived: 1}.derived))]) // $derived\n'
  v=O.validate(code,[]);self.assertIn('Text("$derived")',v['canonicalCode']);self.assertIn('// $derived',v['canonicalCode']);self.assertIn('{$derived: 1}',v['canonicalCode']);self.assertIn('_jarvisDerived1 =',v['canonicalCode']);self.assertEqual(v['formulaStates'],['$x'])
 def test_editable_expressions_are_not_silently_lowered_to_readonly(self):
  for body in ['Input($y, "Amount", "number")','Button("Reset", @Set($y, 0)), Text(@Format($y))']:
   with self.assertRaisesRegex(ValueError,'literal initial value'):O.validate('$x = 2\n$y = $x * 3\nroot = Col(['+body+'])',[])
class ProviderProtocolTests(unittest.TestCase):
 def test_no_textual_tool_protocol_is_published_or_executed(self):
  calls=[];diagnostics=[];lookups=[]
  def provider(messages,*args):
   calls.append(messages)
   if len(calls)==1:yield {'content':'<｜｜DS'};yield {'content':'ML｜｜ calls>\n<｜｜DSML｜｜ invoke name="web_search">\n'}
   elif len(calls)==2:yield {'tool_calls':[{'index':0,'id':'public-read','function':{'name':'web_search','arguments':'{"query":"example changes","limit":1}'}}]}
   else:yield {'content':'Here are the changes.\n```openui\nroot = Col([Text("Verified finding")])\n```'}
  def lookup(name,args):lookups.append(name);return {'results':[{'url':'https://docs.python.org/3/whatsnew/3.14.html','title':'Fixture source'}]}
  text=''.join(O.stream('Check differences','fixture','fixture',provider=provider,lookup=lookup,on_diagnostic=diagnostics.append));self.assertNotIn('DSML',text);self.assertEqual(len(calls),3);self.assertEqual(lookups,['web_search']);self.assertEqual(O.finalize(text)[0],'ok');self.assertTrue(any(d['code']=='provider_protocol_leak' for d in diagnostics))
 def test_fenced_protocol_example_stays_code(self):
  text='```xml\n<｜｜DSML｜｜ calls>\n```\n';self.assertEqual(O._Transport(lambda:[]).feed(text,final=True),text)
 def test_sampling_and_named_tool_choice_respect_thinking_mode(self):
  for effort in ('none','high'):
   requests=[]
   def urlopen(request,**kwargs):requests.append(json.loads(request.data));return io.BytesIO(b'data: [DONE]\n')
   token=O.POLICY.set({'reasoning':effort,'require_read':True})
   try:
    with patch.object(O.urllib.request,'urlopen',urlopen):list(O._provider([], 'fixture','fixture',[{'function':{'name':'web_search'}}]))
   finally:O.POLICY.reset(token)
   if effort=='none':self.assertEqual(requests[0]['temperature'],0);self.assertIsInstance(requests[0]['tool_choice'],dict)
   else:self.assertNotIn('temperature',requests[0]);self.assertEqual(requests[0]['tool_choice'],'auto')
if __name__=='__main__':unittest.main()
