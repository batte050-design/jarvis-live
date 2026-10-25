import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

P=argparse.ArgumentParser();P.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));A,REST=P.parse_known_args();ROOT=Path(A.root).resolve()

class IsolationTests(unittest.TestCase):
    def test_missing_access_reports_all_six_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            out=Path(d)/'results.json'
            run=subprocess.run([sys.executable,str(ROOT/'tools/acceptance_agent_turns.py'),'--source',str(ROOT),'--output',str(out)],capture_output=True,text=True,env={**os.environ,"PYTHONDONTWRITEBYTECODE":"1"})
            self.assertTrue(out.exists(),'no dedicated-state harness/report exists')
            data=json.loads(out.read_text());self.assertEqual(len(data['cases']),6);self.assertTrue(all(r['status']=='BLOCKED' for r in data['cases']));self.assertEqual(run.returncode,2)

    def test_confinement_enforces_writes_or_refuses_without_running(self):
        self.assertTrue((ROOT/'tools/acceptance_isolation.py').exists(),'no write-confinement harness exists')
        with tempfile.TemporaryDirectory() as d:
            base=Path(d);inside=base/'inside';inside.mkdir();outside=base/'outside';outside.write_text('unchanged')
            code="import sys;sys.path.insert(0,sys.argv[1]);from acceptance_isolation import confine_writes;from pathlib import Path;confine_writes(sys.argv[2]);Path(sys.argv[2],'ok').write_text('private');\ntry:Path(sys.argv[3]).write_text('bad')\nexcept PermissionError:pass\nelse:raise AssertionError('outside write allowed')"
            run=subprocess.run([sys.executable,'-c',code,str(ROOT/'tools'),str(inside),str(outside)],capture_output=True,text=True,env={**os.environ,"PYTHONDONTWRITEBYTECODE":"1"})
            self.assertEqual(outside.read_text(),'unchanged')
            if run.returncode:
                self.assertIn('Landlock unavailable:',run.stderr);self.assertFalse((inside/'ok').exists());print('Native confinement BLOCKED by kernel; fail-closed refusal verified')
            else:self.assertEqual((inside/'ok').read_text(),'private')

if __name__=='__main__':unittest.main(argv=['test_acceptance_isolation.py']+REST)
