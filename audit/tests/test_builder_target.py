import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

P=argparse.ArgumentParser();P.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));A,REST=P.parse_known_args();ROOT=Path(A.root).resolve()

class BuilderTargetTests(unittest.TestCase):
    def test_explicit_target_refusals_then_deterministic_build(self):
        source=(ROOT/'build_v1.py').read_text()
        # Refuse to execute an unpatched hardcoded builder, even in this test.
        self.assertNotIn('HERE = "/data/apps/jarvis-live"',source,'builder can still target the deployed app')
        # OpenUI adds fixed local assets to the existing bootstrap. All safety guards below still run.
        self.assertIn('"openui-parent.js"',source)
        self.assertIn('"openui-frame.js", "openui-frame.css"',source)
        with tempfile.TemporaryDirectory() as d:
            app=Path(d)/'copy'
            # A real copy of the tree: the merged builder resolves the response layer and its assets.
            shutil.copytree(ROOT,app,ignore=shutil.ignore_patterns('.git','__pycache__','node_modules'))
            (app/'index_v1.html').unlink(missing_ok=True)   # start with no built page, as the original test did
            def run(*args):return subprocess.run([sys.executable,str(app/'build_v1.py'),*args],cwd=d,capture_output=True,text=True)
            for args in [(),('--target','.'),('--target',d),('--target',str(app/'missing'))]:
                result=run(*args);self.assertNotEqual(result.returncode,0,args);self.assertFalse((app/'index_v1.html').exists())
            result=run('--target',str(app));self.assertEqual(result.returncode,0,result.stderr);first=(app/'index_v1.html').read_bytes()
            result=run('--target',str(app));self.assertEqual(result.returncode,0,result.stderr);self.assertEqual((app/'index_v1.html').read_bytes(),first)
            (app/'index_v1.html').unlink();outside=Path(d)/'outside';outside.write_text('unchanged');(app/'index_v1.html').symlink_to(outside)
            result=run('--target',str(app));self.assertNotEqual(result.returncode,0);self.assertEqual(outside.read_text(),'unchanged')

if __name__=='__main__':unittest.main(argv=['test_builder_target.py']+REST)
