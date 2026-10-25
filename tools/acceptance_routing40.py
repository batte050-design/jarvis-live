#!/usr/bin/env python3
"""Run the routing corpus against real isolated app/provider/tools. No simulated search PASS.
The deterministic fixture's fault scenarios are not injected into this native run.
"""
import argparse
import http.server
import json
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import urllib.parse
import sys
sys.dont_write_bytecode=True
from acceptance_agent_turns import IsolatedApp,collect,preflight


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--hermes-bin',type=Path);p.add_argument('--agent-home-template',type=Path);p.add_argument('--model');p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    source=a.source.resolve();output=a.output.resolve()
    if source in output.parents:raise SystemExit('report must be outside the source/deployed tree')
    corpus=json.loads((Path(__file__).resolve().parents[1]/'tests/routing40.json').read_text())
    missing=preflight(a.hermes_bin)
    if not a.agent_home_template or not (a.agent_home_template/'config.yaml').is_file():missing.append('explicit agent-home template/config.yaml')
    root=Path(tempfile.mkdtemp(prefix='jarvis-routing40-'));app=None;site_server=None;rows=[];hits=[];nonce=secrets.token_hex(16);canary=secrets.token_hex(16)
    class Fixture(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if not self.path.startswith('/'+nonce+'/'):self.send_error(404);return
            hits.append(self.path);body=json.dumps({'private_site_test_value':canary}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def log_message(self,*args):pass
    try:
        if not missing:
            try:
                site_server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Fixture);threading.Thread(target=site_server.serve_forever,daemon=True).start()
                app=IsolatedApp.__new__(IsolatedApp);app.__init__(source,a.hermes_bin.resolve(),a.agent_home_template.resolve(),a.model,root)
                site='http://127.0.0.1:'+str(site_server.server_address[1])+'/'+nonce
                with (app.home/'MEMORY.md').open('a') as f:f.write('\nPrivate site URL: '+site+'/dashboard\n')
            except Exception as e:missing.append(str(e))
        for case in corpus:
            result={'id':case['id'],'group':case['group'],'q':case['q'],'expected':{'web':case['web'],'memory':case['memory'],'agent':case['agent']}}
            if missing:result.update(status='BLOCKED',reason='; '.join(missing));rows.append(result);continue
            try:
                conv=secrets.token_hex(16);tid=secrets.token_hex(16)
                app.request('/api/chat/'+conv+'/turnopts',{'web':case.get('stored_web',case['web']),'memory':case['memory']})
                settings=app.request('/api/chat/'+conv+'/turnopts')
                assert settings['web']==case['web'] and settings['memory']==case['memory'],'settings did not persist'
                q=case['q'].replace('https://private.example.test',site)
                if case['group']=='private-site':q+=' Return the private_site_test_value obtained from that site.'
                before=len(hits)
                payload={'q':q,'mode':'text','conv':(' '+conv+' ') if case.get('spaced_conv') else conv,'turn_id':tid}
                events=collect(app.request('/stream',payload,stream=True))
                tools=[d.get('tool') for name,d in events if name=='term' and d.get('kind')=='run']
                work=any(name=='work' and d.get('state')=='start' for name,d in events)
                errors=[d for name,d in events if name=='err'];answers=[d.get('text','') for name,d in events if name=='text']
                assert work==case['agent'],'wrong actual front/agent path'
                assert not errors and answers,'turn failed or had no settled answer'
                if case['group']=='live-web' or case['web']=='always':assert any(t in ('web_search','web_extract','browser_exec') for t in tools),'no observed web tool'
                if case['group']=='private-site':assert len(hits)>before and canary in answers[-1],'private site was not fetched/read'
                if case['memory']=='off':
                    assert app.marker not in answers[-1] and canary not in answers[-1],'private memory leaked'
                    assert not any(t and 'memory' in t.lower() for t in tools),'memory tool ran while off'
                if case['group']=='neither' and case['web']=='auto':assert not tools,'unneeded tools ran'
                result.update(status='PASS',actual={'settings':{'web':settings['web'],'memory':settings['memory']},'agent':work,'tools':tools,'private_site_read':len(hits)>before,'memory_canary_leaked':app.marker in answers[-1]})
            except Exception as e:result.update(status='FAIL',reason=str(e)[:500])
            rows.append(result)
    finally:
        if app:app.close()
        if site_server:site_server.shutdown();site_server.server_close()
        shutil.rmtree(root)
    report={'kind':'real isolated app/provider/tools; no scripted agent results','rows':rows}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'prompts':len(rows),'pass':sum(r['status']=='PASS' for r in rows),'fail':sum(r['status']=='FAIL' for r in rows),'blocked':sum(r['status']=='BLOCKED' for r in rows)},indent=2))
    return 2 if any(r['status']=='BLOCKED' for r in rows) else int(any(r['status']!='PASS' for r in rows))

if __name__=='__main__':raise SystemExit(main())
