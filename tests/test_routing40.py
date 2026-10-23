import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from routing40_driver import drive

P=argparse.ArgumentParser();P.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));P.add_argument('--report',type=Path);A,REST=P.parse_known_args();ROOT=Path(A.root).resolve();ROWS=json.loads((Path(__file__).parent/'routing40.json').read_text())

class RoutingTests(unittest.TestCase):
    def test_forty_decisions_and_observable_boundaries(self):
        report=[]
        for row in ROWS:
            with self.subTest(prompt=row['id']),tempfile.TemporaryDirectory() as d:
                with contextlib.redirect_stdout(io.StringIO()):actual=drive(ROOT,d,row)
                errors=[]
                if actual['selected']['web']!=row['web']:errors.append('wrong per-chat web setting')
                if actual['selected']['memory']!=row['memory']:errors.append('wrong per-chat memory setting')
                if actual['selected']['want_web']!=(row['web']=='always') or actual['selected']['web_off']:errors.append('wrong effective web flags')
                if actual['selected']['want_memory']!=(row['memory']=='on'):errors.append('wrong effective memory flag')
                if bool(actual['agent_calls'])!=row['agent']:errors.append('wrong actual front/agent path')
                if len(actual['agent_calls'])!=row['agent_calls']:errors.append('wrong number of agent calls')
                if bool(actual['front_requests'])==row['agent']:errors.append('wrong actual front provider request')
                if row['memory']=='off' and actual['front_requests']:errors.append('private profile reached fast-provider body')
                for call in actual['agent_calls']:
                    if call['memory']!=(row['memory']=='on'):errors.append('wrong memory flag at agent boundary')
                    if call['web']!=(row['web']=='always'):errors.append('wrong web requirement at agent boundary')
                    if call['web_off']!=actual['selected']['web_off']:errors.append('wrong web-off flag at agent boundary')
                    if call['mode']!='text':errors.append('wrong mode')
                if row['web_behavior']=='search' and 'web_search' not in actual['observed_tools']:errors.append('no current-turn web tool event')
                if row['web_behavior']=='private-read' and 'browser_exec' not in actual['observed_tools']:errors.append('no private-site tool event')
                if row['web_behavior']=='provider-never-searches' and not actual['errors']:errors.append('Always accepted without a tool on this turn')
                report.append({'id':row['id'],'q':row['q'],'group':row['group'],'predicted_failure':row['predicted_failure'],'actual':actual,'errors':errors,'status':'FAIL' if errors else 'PASS'})
                self.assertFalse(errors,errors)
        if A.report:A.report.write_text(json.dumps({'kind':'deterministic real decision/recorded provider and CLI boundaries; not live tool proof','rows':report},indent=2)+'\n')

if __name__=='__main__':unittest.main(argv=['test_routing40.py']+REST)
