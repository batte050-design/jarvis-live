#!/usr/bin/env python3
"""Real app/model acceptance; no fixtures, no claim of native frame mounting."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
sys.dont_write_bytecode=True


def main():
    p=argparse.ArgumentParser();p.add_argument('--origin');p.add_argument('--cookie-file',type=Path);p.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    source=a.source.resolve();output=a.output.resolve();missing=[];cookie=''
    if output==source or source in output.parents:raise SystemExit('report must be outside app source')
    if not a.origin:missing.append('explicit app origin required')
    else:
        u=urllib.parse.urlsplit(a.origin)
        if u.username or u.password or u.query or u.fragment or u.path not in ('','/') or (u.scheme!='https' and not (u.scheme=='http' and u.hostname in ('127.0.0.1','localhost'))):raise SystemExit('HTTPS origin without credentials/path required')
        a.origin=a.origin.rstrip('/')
    if not a.cookie_file or not a.cookie_file.is_file():missing.append('authenticated private cookie file required; never paste a cookie into chat')
    else:
        if os.name=='posix' and a.cookie_file.stat().st_mode & 0o077:raise SystemExit('cookie file must have owner-only permissions (0600)')
        cookie=a.cookie_file.read_text().strip()
        if not cookie.startswith('jl=') or re.search(r'[\r\n]',cookie):raise SystemExit('cookie file must contain the existing jl Cookie header value')
    def request(path,payload=None):
        req=urllib.request.Request(a.origin+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Cookie':cookie,'Origin':a.origin,'Content-Type':'application/json'})
        return urllib.request.urlopen(req,timeout=600)
    code="const fs=require('fs'),c=require(process.argv[1]+'/static/response-core.js')(JSON.parse(fs.readFileSync(process.argv[1]+'/response-capabilities.json'))),s=JSON.parse(fs.readFileSync(0)),r=c.validate(s);if(!r.ok)throw Error(r.reason);console.log(JSON.stringify({initial:r.initial,outputs:r.spec.outputs,env:c.evaluate(r.spec,r.initial)}));"
    rows=[]
    for case in json.loads((Path(__file__).resolve().parents[1]/'tests/authoring10.json').read_text()):
        row={'id':case['id'],'prompt':case['prompt'],'expected':case['shape'],'actual':None,'nativeFrame':'NOT_TESTED'}
        if missing:row.update(status='BLOCKED',reason='; '.join(missing));rows.append(row);continue
        try:
            conv=secrets.token_hex(16);tid=secrets.token_hex(16);events=[];kind=None
            with request('/stream',{'q':case['prompt'],'mode':'text','conv':conv,'turn_id':tid}) as response:
                for raw in response:
                    line=raw.decode().rstrip('\r\n')
                    if line.startswith('event: '):kind=line[7:]
                    elif line.startswith('data: ') and kind:
                        events.append((kind,json.loads(line[6:])))
                        if kind=='done':break
            errors=[d for k,d in events if k=='err'];answers=[d.get('text','') for k,d in events if k=='text'];answer=answers[-1] if answers else ''
            row.update(answer=answer,errors=errors)
            matches=list(re.finditer(r'^```ui\s*\n([\s\S]*?)^```[ \t]*$',answer,re.M));spec=None
            if len(matches)==1:
                try:spec=json.loads(matches[0][1])
                except ValueError:pass
            row['actual']=spec.get('component') if isinstance(spec,dict) and 'version' in spec else 'prose'
            assert not errors and answer,'turn error or no settled answer'
            assert any(k=='done' for k,d in events),'no turn completion'
            assert row['actual']==case['shape'],'required shape returned '+str(row['actual'])
            if case['shape']!='prose':
                assert '[[file:' not in answer and 'Drag the slider' not in answer,'file handoff or ungrounded instruction'
                check=subprocess.run(['node','-e',code,str(source)],input=json.dumps(spec),text=True,capture_output=True)
                assert check.returncode==0,'existing validator rejected declaration'
                actual=json.loads(check.stdout)
                if case['id']=='quote':assert actual['initial']=={'quantity':6,'price':10000,'discount':7166} and actual['env']['total']==17004,'wrong quote values'
                if case['id']=='bill':assert actual['initial']=={'bill':100001,'people':3,'tip':0},'wrong bill values'
                if case['id']=='budget':assert actual['initial']=={'income':1000000,'housing':300000,'food':200000,'other':100000} and actual['env']['remaining']==400000 and any(o['kind']=='chart' and o['chart']=='bar' for o in actual['outputs']),'wrong budget or missing bars'
                if case['id']=='comparison':assert sorted(r[1] for r in actual['outputs'][1]['rows'])==[500,1000],'wrong comparison prices'
                if case['id']=='chart':assert {v['label'].lower():v['value'] for v in actual['outputs'][0]['points']}=={'january':10,'february':20,'march':15},'wrong chart values'
                if case['id']=='quiz':
                    choice=next(i for i in spec['inputs'] if i['id']==actual['outputs'][0]['input']);correct=next(o['label'] for o in choice['options'] if o['value']==actual['outputs'][0]['answer'])
                    assert correct=='4','wrong quiz answer'
            if case['id']=='arithmetic':assert re.search(r'\b56\b',answer),'wrong arithmetic answer'
            if case['id']=='source':assert 'berners' in answer.lower() and re.search(r'https://(?:home\.cern|(?:www\.)?w3\.org)/',answer),'missing factual answer or primary source URL'
            with request('/api/sessions/'+conv) as saved:data=json.load(saved)
            assert any(t.get('a')==answer for t in data.get('turns',[])),'settled answer not stored in its conversation'
            row['status']='PASS'
        except urllib.error.HTTPError as e:
            if e.code in (401,403):missing.append('app authentication refused; sign-in required');row.update(status='BLOCKED',reason=missing[-1])
            else:row.update(status='FAIL',reason='app HTTP '+str(e.code))
        except Exception as e:row.update(status='FAIL',reason=str(e)[:240])
        rows.append(row)
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps({'kind':'REAL app/model turns, not native frame proof','rows':rows},indent=2)+'\n')
    for row in rows:print(row['id']+': expected='+row['expected']+' actual='+str(row['actual'])+' '+row['status'])
    return 2 if any(r['status']=='BLOCKED' for r in rows) else int(any(r['status']!='PASS' for r in rows))

if __name__=='__main__':raise SystemExit(main())
