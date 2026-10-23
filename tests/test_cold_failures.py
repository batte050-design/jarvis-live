import argparse
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from turn_test_support import agent_environment
from routing40_driver import drive

P=argparse.ArgumentParser();P.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));A,REST=P.parse_known_args();ROOT=Path(A.root).resolve()

class ColdFailureTests(unittest.TestCase):
    def test_three_forced_failures_repeat_without_success_or_answer_commit(self):
        for scenario in ('kill','provider-refusal','spawn-failure'):
            for repeat in range(3):
                with self.subTest(fault=scenario,repeat=repeat),tempfile.TemporaryDirectory() as d:
                    binary=Path(d)/'hermes'
                    if scenario!='spawn-failure':binary.write_bytes((Path(__file__).parent/'fake_agent.py').read_bytes());binary.chmod(0o700)
                    (Path(d)/'scenario').write_text(scenario)
                    env=agent_environment(ROOT,d,binary)
                    row={'q':'Read me the test result.','web':'always','memory':'on','web_behavior':'none'}
                    output=io.StringIO()
                    with contextlib.redirect_stdout(output):actual=drive(ROOT,d,row,agent_impl=env['hermes_answer'])
                    self.assertEqual(actual['finished'],['failed'], 'failure counted as completed')
                    self.assertTrue(actual['errors']);self.assertTrue(actual['errors'][0]['message'].startswith('The agent turn failed'))
                    self.assertIn('ERROR agent',output.getvalue());self.assertEqual(len(actual['agent_calls']),1,'failed child was automatically rerun')
                    # drive's boundary recorder must never observe a successful answer write.
                    self.assertFalse(actual.get('stored',[]),'failure was stored as an answer')

if __name__=='__main__':unittest.main(argv=['test_cold_failures.py']+REST)
