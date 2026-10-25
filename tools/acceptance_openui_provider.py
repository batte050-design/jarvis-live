#!/usr/bin/env python3
"""Optional, billable existing-provider check. Not part of the offline suite. Never reads .env."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import response_authoring as A
import response_sources as S


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run',action='store_true',help='Explicitly run three small paid provider requests')
    p.add_argument('--model',required=True,help='The already configured front model, unchanged')
    p.add_argument('--report',type=Path,required=True)
    args=p.parse_args()
    key=os.environ.get('DEEPSEEK_API_KEY')
    if not args.run or not key:
        p.error('--run and the existing DEEPSEEK_API_KEY environment are required; no key value is accepted as an argument')
    rows=[]
    cases=[('quote','Help me price a job: four inspections at UGX 80,000 each, 10% off. I want to adjust it.'),
           ('plan','Plan a quiet afternoon using a timeline and a carousel of indoor and outdoor alternatives. No invented places or numerical facts. Use one composed answer.'),
           ('form','Make a local inspection preferences form: a text area for notes, date picker default 2026-10-24, short/detailed report select, include-photos checkbox. Show the live summary. Use one composed answer; no send action.')]
    for name,q in cases:
        with S.turn(q):
            status,text=A.author(q,[{'role':'user','content':q} ],args.model,key)
        ok=False;reason='No complete declaration';kind=None
        if status=='ok' and text.startswith('```ui\n'):
            try:
                spec=json.loads(text.split('```ui\n')[1].split('\n```')[0])
                code="const c=require('./static/response-core.js')(require('./response-capabilities.json'));let r=c.validate(JSON.parse(require('fs').readFileSync(0)));console.log(JSON.stringify({ok:r.ok,reason:r.reason,initial:r.initial,component:r.spec&&r.spec.component}));"
                checked=subprocess.run(['node','-e',code],cwd=ROOT,input=json.dumps(spec),text=True,capture_output=True,check=True)
                result=json.loads(checked.stdout);kind=spec['component'];ok=result['ok'] and bool(spec.get('layout'));reason=result.get('reason','')
                if name=='quote':ok=ok and result['initial']=={'quantity':4,'price':80000,'discount':1000}
                if name=='plan':ok=ok and {'Timeline','Carousel'} <= {n['kind'] for n in spec['layout']}
                if name=='form':ok=ok and {'TextArea','DatePicker','Select','Checkbox'} <= {n['kind'] for n in spec['layout']}
            except (ValueError,KeyError,IndexError,subprocess.SubprocessError):reason='Invalid declaration'
        rows.append({'case':name,'status':status,'passed':bool(ok),'component':kind,'reason':reason})
        print(('PASS ' if ok else 'FAIL ')+name,flush=True)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps({'kind':'Actual existing provider; three bounded requests, no retries or state writes','rows':rows},indent=2)+'\n')
    return 0 if all(r['passed'] for r in rows) else 1


if __name__=='__main__':sys.exit(main())
