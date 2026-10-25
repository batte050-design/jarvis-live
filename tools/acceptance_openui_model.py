#!/usr/bin/env python3
"""Optional real-provider gate: three fresh text questions, no live app or configuration writes."""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import response_openui as O


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run',action='store_true',help='Explicitly spend three bounded calls using the existing provider')
    p.add_argument('--model',default=os.environ.get('JARVIS_FRONT_MODEL','deepseek-v4-flash'))
    p.add_argument('--report',type=Path,required=True)
    a=p.parse_args()
    if not a.run or not os.environ.get('DEEPSEEK_API_KEY'):
        p.error('requires --run and DEEPSEEK_API_KEY in the process environment; never put credentials in arguments')
    fixture=json.loads((ROOT/'tests/fixtures/openui-lang.json').read_text());rows=[]
    for name in ('images','plain','quote'):
        started=time.monotonic();row=fixture[name];answer=''.join(O.stream(row['question'],a.model,os.environ['DEEPSEEK_API_KEY'],network=False))
        status,text=O.finalize(answer);programs=list(O.parts(text));errors=[]
        if status!='ok':errors.append('presentation did not complete')
        if name=='images' and not any(re.search(r'\b(?:SearchImage|Image)\s*\(',part[2]) for part in programs):errors.append('no image primitive')
        if name=='quote' and not any(re.search(r'\bInput\s*\(',part[2]) for part in programs):errors.append('no adjustable input')
        if name=='plain' and (programs or re.search(r'controls|adjustable|interactive version',text,re.I)):errors.append('plain request got UI or a control apology')
        rows.append({'name':name,'question':row['question'],'text':text,'status':status,'seconds':round(time.monotonic()-started,3),'errors':errors})
        print(('PASS' if not errors else 'FAIL')+' '+name,flush=True)
    report={'kind':'Actual existing-provider generation, no canned emitter or scripted model response. Browser rendering/recomputation is a separate gate.','model':a.model,'passed':sum(not r['errors'] for r in rows),'total':len(rows),'rows':rows}
    a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2)+'\n')
    return 0 if report['passed']==report['total'] else 1


if __name__=='__main__':sys.exit(main())
