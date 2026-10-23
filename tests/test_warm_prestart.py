import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from turn_test_support import agent_environment, symbols

P=argparse.ArgumentParser();P.add_argument('--root',default=str(Path(__file__).resolve().parents[1]));ARGS,REST=P.parse_known_args();ROOT=Path(ARGS.root).resolve()

class WarmTests(unittest.TestCase):
    def wait(self,env,name):
        deadline=time.monotonic()+6
        while name in env['WARM_BUILDING'] and time.monotonic()<deadline:time.sleep(.01)
        self.assertNotIn(name,env['WARM_BUILDING'],'build did not finish')

    def test_prestart_then_real_decision_uses_same_built_process(self):
        with tempfile.TemporaryDirectory() as d:
            # The fixture is a real child speaking ACP, not Hermes/provider proof.
            binary=Path(d)/'hermes';binary.write_bytes((Path(__file__).parent/'fake_agent.py').read_bytes());binary.chmod(0o700)
            env=agent_environment(ROOT,d,binary);conv='a'*32;name=env['agent_session_name'](conv)
            try:
                env['warm_prewarm_for'](name);self.wait(env,name)
                agent=env['WARM_AGENTS'][name];self.assertTrue(agent.ready());pid=agent._proc.pid
                live=[];result=env['hermes_answer']('Read me the fixture.',mode='text',conv=conv,on_event=lambda *args,**kw:live.append(args))
                self.assertEqual(result,('ok','Fixture answer.'));self.assertIs(env['WARM_AGENTS'][name],agent);self.assertEqual(agent._proc.pid,pid)
                rows=[json.loads(x) for x in (Path(d)/'trace.jsonl').read_text().splitlines()]
                self.assertEqual([r['event'] for r in rows].count('built'),1)
                self.assertFalse(any(r['event']=='cold' for r in rows),'decision ignored the built child')
                prompt=next(r for r in rows if r['event']=='prompt')
                self.assertEqual(prompt['chat'],conv);self.assertTrue(prompt['guard_context_present'])
                self.assertIn('THREAD '+conv,prompt['prompt']);self.assertIn('TEXT FORMAT.',prompt['prompt'])
                self.assertTrue(any(r[0]=='live' for r in live))
            finally:
                for agent in env['WARM_AGENTS'].values():agent.close()

    def test_failed_build_is_reported_and_same_name_can_retry(self):
        with tempfile.TemporaryDirectory() as d:
            binary=Path(d)/'hermes';binary.write_bytes((Path(__file__).parent/'fake_agent.py').read_bytes());binary.chmod(0o700)
            scenario=Path(d)/'scenario';scenario.write_text('build-refusal')
            env=agent_environment(ROOT,d,binary);name=env['agent_session_name']('b'*32)
            try:
                captured=io.StringIO()
                with contextlib.redirect_stdout(captured):
                    env['warm_prewarm_for'](name);self.wait(env,name)
                self.assertGreater(env['WARM_FAILURES'].get(name,0),0,'failed build was not retained in decision state')
                self.assertIn('fixture provider refused',captured.getvalue())
                scenario.write_text('ok');self.assertTrue(env['warm_prewarm_for'](name),'failed cached object suppressed retry');self.wait(env,name)
                self.assertTrue(env['WARM_AGENTS'][name].ready());self.assertEqual(env['WARM_FAILURES'][name],0)
            finally:
                for agent in env['WARM_AGENTS'].values():agent.close()

    def test_real_reset_warms_page_id_without_changing_stored_window_transition(self):
        with tempfile.TemporaryDirectory() as d:
            binary=Path(d)/'hermes';binary.write_bytes((Path(__file__).parent/'fake_agent.py').read_bytes());binary.chmod(0o700)
            base=agent_environment(ROOT,d,binary)
            from types import SimpleNamespace as NS
            base.update(HISTORY_LOCK=__import__('threading').RLock(),HISTORY=[],TURN={'n':0},archive_session=lambda *a:None,
                authed=lambda r:True,same_origin=lambda r:True,auth_scope=lambda r:'master',invalidate_conv=lambda c:None,
                HISTORY_FILE=str(Path(d)/'history.json'),ART_SEQ=[0],broadcast_art=lambda d:None)
            env=symbols(ROOT,['new_session','reset'],base);env['close_session']=env['new_session'];page='c'*32
            try:
                result=env['reset'](NS(query_params={'prestart':page}))
                self.wait(base,base['agent_session_name'](page))
                self.assertIn(base['agent_session_name'](page),base['WARM_AGENTS'],'reset warmed its private UUID instead of the page conversation')
                self.assertNotEqual(result['session'],page,'warm hint changed the original stored-window transition')
                self.assertEqual(getattr(base['WARM_PRESTART'],'conv',''),'','hint escaped its reset request')
            finally:
                for agent in base['WARM_AGENTS'].values():agent.close()

    def test_prestart_route_denies_before_allocating(self):
        allocations=[]
        env=symbols(ROOT,['agent_prestart'],dict(auth_scope=lambda r:r.scope,same_origin=lambda r:r.origin,
            tombstoned=lambda c:False,rate_ok=lambda *a:True,warm_prewarm_for=allocations.append,agent_session_name=str))
        import asyncio
        from types import SimpleNamespace as NS
        for scope,origin,conv in [('voice',True,'c'*32),('master',False,'c'*32),('master',True,'current')]:
            result=asyncio.run(env['agent_prestart'](conv,NS(scope=scope,origin=origin)));self.assertNotEqual(result.status_code,200)
        self.assertEqual(allocations,[])

if __name__=='__main__':unittest.main(argv=['test_warm_prestart.py']+REST)
