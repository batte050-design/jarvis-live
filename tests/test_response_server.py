"""No FastAPI import or live service needed: test actual assets, helpers and route bodies."""
import argparse
import ast
import asyncio
import base64
import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import types
import unittest

PARSER = argparse.ArgumentParser()
PARSER.add_argument('--root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
PARSER.add_argument('--group', choices=['all','assets','settings','builder','guards'], default='all')
ARGS = PARSER.parse_args()
ROOT = ARGS.root.resolve()
if not (ROOT / 'response_layer.py').exists():
    raise AssertionError('declarative response assets are not installed')
spec = importlib.util.spec_from_file_location('response_under_test', ROOT / 'response_layer.py')
LAYER = importlib.util.module_from_spec(spec)
spec.loader.exec_module(LAYER)


class AssetTests(unittest.TestCase):
    def test_manifest_and_stamp(self):
        m, digest, stamp, *_ = LAYER.assets()
        self.assertEqual(digest, hashlib.sha256(LAYER.canonical(m).encode()).hexdigest())
        self.assertEqual(len(stamp),64)
        self.assertEqual(m['dataEndpoints'],{})
        self.assertEqual(m['classes'],['LOCAL','DATA','AGENT'])
        subprocess.run(['node','--check',str(ROOT/'static/response-core.js')],check=True)
        subprocess.run(['node','--check',str(ROOT/'static/response-runtime.js')],check=True)

    def test_fixed_document_has_exact_csp_hashes(self):
        html, headers = LAYER.document('https://app.example.test')
        script = re.search(r'<script>(.*?)</script>',html,re.S).group(1)
        style = re.search(r'<style>(.*?)</style>',html,re.S).group(1)
        csp = headers['Content-Security-Policy']
        for source in (script,style):
            self.assertIn('sha256-'+base64.b64encode(hashlib.sha256(source.encode()).digest()).decode(),csp)
        for token in ("sandbox allow-scripts","connect-src 'none'","frame-ancestors https://app.example.test"):
            self.assertIn(token,csp)
        for token in ('unsafe-inline','allow-same-origin','allow-top-navigation','https://cdn','innerHTML','eval('):
            self.assertNotIn(token,script+style+csp)
        self.assertNotRegex(html,r'<script[^>]+src=')
        self.assertNotRegex(html,r'\son[a-z]+=')


class SettingsTests(unittest.TestCase):
    def test_namespaced_atomic_update_preserves_other_settings(self):
        with tempfile.TemporaryDirectory() as d:
            path = pathlib.Path(d)/'chat_settings.json'
            initial={'a':{'web':'always','memory':'off','other':{'x':1}},'b':{'web':'auto'}}
            path.write_text(json.dumps(initial))
            result=LAYER.save_preferences(str(path),'a',{'agent':True},threading.RLock())
            self.assertTrue(result['agent'])
            saved=json.loads(path.read_text())
            for k,v in initial['a'].items(): self.assertEqual(saved['a'][k],v)
            self.assertEqual(saved['b'],initial['b'])
            self.assertEqual(LAYER.preferences(str(path),'a'),result)
            self.assertEqual(LAYER.preferences(str(path),'b'),LAYER.assets()[0]['defaults'])
            before=path.read_bytes()
            for invalid in ({'web':'off'},{'agent':'true'},{'agent':1},{},[]):
                with self.assertRaises(ValueError): LAYER.save_preferences(str(path),'a',invalid,threading.RLock())
                self.assertEqual(path.read_bytes(),before)

    def test_corrupt_store_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            path=pathlib.Path(d)/'settings.json';path.write_text('{broken')
            self.assertFalse(any(LAYER.preferences(str(path),'a').values()))
            with self.assertRaises(ValueError): LAYER.save_preferences(str(path),'a',{'agent':True},threading.RLock())
            self.assertEqual(path.read_text(),'{broken')


def routes():
    tree=ast.parse((ROOT/'server.py').read_text())
    names={'response_runtime','response_context','response_preferences'}
    definitions=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
    if {n.name for n in definitions} != names: raise AssertionError('response routes missing')
    class App:
        def get(self,*a,**k): return lambda fn:fn
        post=get
    class Reply:
        def __init__(self,content,status_code=200,headers=None):self.content,self.status_code,self.headers=content,status_code,headers
    env={'app':App(),'Request':object,'JSONResponse':Reply,'HTMLResponse':Reply,'RESPONSE_LAYER':LAYER,
         'WIDGETS':types.SimpleNamespace(enabled=lambda:True,host=lambda:'widgets.example.test'),
         'PUBLIC_HOST':'app.example.test','_widget_host_ok':lambda r:r.widget,'auth_scope':lambda r:r.scope,
         'same_origin':lambda r:r.same,'_guard':lambda r:r.owner,'accounts':lambda:{'accounts':{'owner':{'id':'owner'}}},
         'CHAT_SETTINGS_PATH':str(ROOT/'tests'/'absent-chat-settings.json'),
         'cookie_token':lambda r:r.cookie,'TOKEN':'test-master-secret','hashlib':hashlib,'hmac':__import__('hmac'),
         're':re,'json':json,'approval_lock':threading.RLock}
    exec(compile(ast.Module(body=definitions,type_ignores=[]),'server-response-routes','exec'),env)
    return env


class GuardTests(unittest.TestCase):
    def test_context_scope_origin_and_namespace(self):
        e=routes()
        r=types.SimpleNamespace(scope='full',same=True,owner=False,cookie='secret-cookie')
        answer=e['response_context']('a'*32,r)
        self.assertEqual(answer.status_code,200)
        self.assertNotIn('secret-cookie',json.dumps(answer.content))
        self.assertFalse(answer.content['canConfigure'])
        first=answer.content['epoch'];r.cookie='other-cookie'
        self.assertNotEqual(e['response_context']('a'*32,r).content['epoch'],first)
        for scope,same in [('voice',True),('full',False),(None,True)]:
            r.scope,r.same=scope,same
            self.assertEqual(e['response_context']('a'*32,r).status_code,403)
        r.scope,r.same='master',True
        self.assertEqual(e['response_context']('../bad',r).status_code,400)

    def test_preferences_owner_origin_and_body_budget(self):
        e=routes()
        class Request:
            owner=True;same=True
            def __init__(self,raw):self.raw=raw
            async def stream(self):
                for part in self.raw:yield part
        with tempfile.TemporaryDirectory() as d:
            e['CHAT_SETTINGS_PATH']=str(pathlib.Path(d)/'settings.json')
            r=Request([b'{"agent":true}'])
            for owner,same in [(False,True),(True,False)]:
                r.owner,r.same=owner,same
                self.assertEqual(asyncio.run(e['response_preferences']('a'*32,r)).status_code,403)
            r.owner,r.same=True,True
            self.assertEqual(asyncio.run(e['response_preferences']('a'*32,r)).status_code,200)
            self.assertEqual(asyncio.run(e['response_preferences']('a'*32,Request([b'x'*2049]))).status_code,413)
            self.assertEqual(asyncio.run(e['response_preferences']('a'*32,Request([b'{"agent":1}']))).status_code,400)

    def test_runtime_host_hash_enable_and_sandbox(self):
        e=routes();r=types.SimpleNamespace(widget=False)
        stamp=LAYER.assets()[2]
        self.assertEqual(e['response_runtime'](r,stamp).status_code,404)
        r.widget=True
        self.assertEqual(e['response_runtime'](r,'wrong').status_code,404)
        self.assertEqual(e['response_runtime'](r,stamp).status_code,200)
        e['WIDGETS'].enabled=lambda:False
        self.assertEqual(e['response_runtime'](r,stamp).status_code,503)


class BuilderTests(unittest.TestCase):
    def test_rebuild_is_deterministic_and_engine_is_identical(self):
        with tempfile.TemporaryDirectory() as d:
            target=pathlib.Path(d)/'app'
            shutil.copytree(ROOT,target,ignore=shutil.ignore_patterns('.git','__pycache__'))
            before=(target/'index_v1.html').read_text()
            source=(target/'build_v1.py').read_text()
            # Bind only the pinned builder's hardcoded location, in memory, inside a disposable copy.
            # This never writes the live path and does not change the repository builder.
            location='HERE = "/data/apps/jarvis-live"'
            self.assertEqual(source.count(location),1)
            source=source.replace(location,'HERE = '+repr(str(target)),1)
            runner=pathlib.Path(d)/'run.py';runner.write_text('exec(compile('+repr(source)+',"build_v1.py","exec"),{"__file__":'+repr(str(target/'build_v1.py'))+',"__name__":"__main__"})')
            subprocess.run([sys.executable,str(runner)],check=True,capture_output=True,text=True)
            one=(target/'index_v1.html').read_bytes()
            subprocess.run([sys.executable,str(runner)],check=True,capture_output=True,text=True)
            self.assertEqual(one,(target/'index_v1.html').read_bytes())
            def inline(s):return re.findall(r'<script(?![^>]*src)[^>]*>(.*?)</script>',s,re.S)
            self.assertEqual(inline(before),inline(one.decode()))
            for name in ['response-config.js','response-core.js','response-store.js','response-parent.js','v1.js','response-parent.css']:
                digest=hashlib.sha256((target/'static'/name).read_bytes()).hexdigest()[:10]
                self.assertIn('/static/'+name+'?v='+digest,one.decode())
            self.assertIn('response-assets:',(target/'static/v1.js').read_text())
            self.assertEqual((target/'static/v1.css').read_bytes(),(ROOT/'static/v1.css').read_bytes())
            self.assertEqual((target/'static/approvals-ui.js').read_bytes(),(ROOT/'static/approvals-ui.js').read_bytes())

    def test_admission_precedes_heuristic_and_voice_branch_is_untouched(self):
        js=(ROOT/'static/v1.js').read_text()
        start=js.index('  function fenceBlock(');end=js.index('  function responsePlain(',start)
        body=js[start:end]
        self.assertLess(body.index('JarvisResponses.fence'),body.index('specFallback(spec)'))
        self.assertIn('if (textMode &&',body)
        self.assertIn("host.ask(q,'text')",(ROOT/'static/response-parent.js').read_text())
        tree=ast.parse((ROOT/'server.py').read_text())
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='format_directive')
        self.assertNotIn('RESPONSE_LAYER',ast.unparse(fn.body[-1]))
        fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='shape_hint')
        self.assertIn('mode !=',ast.unparse(fn.body[1]))


if __name__=='__main__':
    classes={'assets':AssetTests,'settings':SettingsTests,'guards':GuardTests,'builder':BuilderTests}
    suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(c) for k,c in classes.items() if ARGS.group in ('all',k))
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
