"""Captured intermittent bill failure and complete repair diagnostics."""
import json,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path[:0]=[str(ROOT),str(ROOT/'tools')]
import response_openui as O
class Revision4Tests(unittest.TestCase):
    def test_captured_bad_bill_reports_full_errors_and_repairs_to_captured_good_bill(self):
        rows=json.loads((ROOT/'tests/fixtures/r4-captured.json').read_text())['rows'];calls=[];diagnostics=[]
        bad=rows[1]['answer'];good=rows[0]['answer']
        errors=O.program_errors(bad)
        self.assertTrue(errors);self.assertGreater(len(errors[0]),200)
        self.assertIn('Text/weight',errors[0]);self.assertIn('Row/gap',errors[0])
        def provider(messages,*args):
            calls.append(messages);yield {'content':bad if len(calls)==1 else good}
        chunks=list(O.stream('Split this bill with editable inputs','fixture','fixture',provider=provider,on_diagnostic=diagnostics.append))
        replacements=[c for c in chunks if isinstance(c,O.Replacement)]
        self.assertEqual(len(calls),2);self.assertEqual(len(replacements),1)
        final=replacements[0].text if hasattr(replacements[0],'text') else str(replacements[0])
        self.assertEqual(O.finalize(final)[0],'ok');self.assertTrue(any(d['phase']=='validation' for d in diagnostics))
        self.assertIn('Row/gap',calls[1][-1]['content'])
    def test_second_repair_receives_the_new_candidate_error(self):
        rows=json.loads((ROOT/'tests/fixtures/r4-captured.json').read_text())['rows'];good=rows[0]['answer'];bad=rows[1]['answer'];calls=[]
        second=good.replace('Title("Bill split", "lg")','Title("Bill split", "gigantic")')
        def provider(messages,*args):
            calls.append(messages);yield {'content':[bad,second,good][len(calls)-1]}
        chunks=list(O.stream('Bill split','fixture','fixture',provider=provider))
        self.assertEqual(len(calls),3);self.assertTrue(any(isinstance(c,O.Replacement) for c in chunks))
        self.assertIn('Title/size',calls[2][-1]['content']);self.assertNotIn('Text/weight',calls[2][-1]['content'])

    def test_unrepaired_program_always_has_diagnostics(self):
        bad=json.loads((ROOT/'tests/fixtures/r4-captured.json').read_text())['rows'][1]['answer'];diagnostics=[]
        def provider(*args):yield {'content':bad}
        chunks=list(O.stream('Bill split','fixture','fixture',provider=provider,on_diagnostic=diagnostics.append));reasons=[]
        self.assertEqual(O.finalize(''.join(chunks),reasons)[0],'partial');self.assertTrue(reasons);self.assertTrue(diagnostics)
if __name__=='__main__':unittest.main()
