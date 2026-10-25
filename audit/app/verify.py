#!/usr/bin/env python3
"""Offline regression runner for the eace50e tree plus defect6; no service or account needed."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--cases',type=Path,default=Path(__file__).resolve().parent/'tests/defect6_cases.json')
    parser.add_argument('--report',type=Path)
    args=parser.parse_args();root=args.root.resolve()
    commands=[('responses',['node','tests/test_responses.js']),
              ('rendering',['node','tests/test_response_repairs.js']),
              ('server',[sys.executable,'tests/test_response_server.py']),
              ('authoring',[sys.executable,'tests/test_response_authoring.py','-v']),
              ('defect6',[sys.executable,'tests/test_defect6.py','--root',str(root),'--cases',str(args.cases.resolve())])]
    records=[]
    for suite,argv in commands:
        try:
            run=subprocess.run(argv,cwd=root,text=True,capture_output=True,timeout=90)
            output=run.stdout+'\n'+run.stderr;code=run.returncode
        except subprocess.TimeoutExpired as exc:
            output='suite exceeded 90 seconds';code=1
        printed=0
        failed_names=set(re.findall(r'^(?:FAIL|ERROR): (test_\w+)',output,re.M))
        for line in output.splitlines():
            if line.startswith(('PASS ','FAIL ')):
                print(line if suite=='defect6' else line[:5]+suite+'/'+line[5:],flush=True);printed+=1
                if line.startswith('FAIL '):code=code or 1
            else:
                match=re.match(r'(test_\w+) \(([^)]+)\) \.\.\. (.*)$',line)
                if match:
                    failed=match[1] in failed_names or match[3].startswith(('FAIL','ERROR','skipped'))
                    print(('FAIL ' if failed else 'PASS ')+suite+'/'+match[1],flush=True);printed+=1
                    if failed:code=code or 1
        if not printed:code=code or 1
        if code:print('FAIL '+suite+'/suite — exit '+str(code),flush=True)
        records.append({'suite':suite,'argv':argv,'exit':code,'output':output})
    if args.report:args.report.write_text(json.dumps(records,indent=2)+'\n')
    failures=[r for r in records if r['exit']]
    if failures:
        for row in failures:print('\n'+row['suite']+' diagnostics:\n'+row['output'][-8000:],file=sys.stderr)
    return 1 if failures else 0


if __name__=='__main__':raise SystemExit(main())
