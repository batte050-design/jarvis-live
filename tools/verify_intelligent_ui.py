#!/usr/bin/env python3
"""Offline UI regressions. Uses scripted providers/children, never the deployed service."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
SUITES = [
    ('ui-painter', ['node','tests/test_intelligent_ui.js']),
    ('ui-prompts', [sys.executable,'tests/test_intelligent_ui.py']),
    ('components', ['node','tests/test_responses.js']),
    ('render-repairs', ['node','tests/test_response_repairs.js']),
    ('authoring', [sys.executable,'tests/test_response_authoring.py']),
    ('server-assets-settings', [sys.executable,'tests/test_response_server.py']),
    ('builder-isolation', [sys.executable,'tests/test_builder_target.py']),
    ('routing-40', [sys.executable,'tests/test_routing40.py']),
    ('cold-failures', [sys.executable,'tests/test_cold_failures.py']),
    ('warm-prestart', [sys.executable,'tests/test_warm_prestart.py']),
    ('failure-client', ['node','tests/test_cold_failure_client.js']),
    ('prestart-client', ['node','tests/test_prestart_client.js']),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path)
    args = parser.parse_args()
    rows = []
    for name,command in SUITES:
        started = time.monotonic()
        try:
            result = subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=180)
            row = dict(suite=name,command=command,exit=result.returncode,output=result.stdout+result.stderr)
        except (OSError,subprocess.TimeoutExpired) as exc:
            row = dict(suite=name,command=command,exit=2,output=str(exc))
        row['seconds'] = round(time.monotonic()-started,3)
        rows.append(row)
        print(('PASS' if row['exit']==0 else 'FAIL')+' '+name,flush=True)
        if row['exit']:
            print(row['output'],flush=True)
    report = {
        'base':'eace50e404baeffadf87f77a096e7244728217dd',
        'kind':'Offline tests using actual repository helpers/painter and scripted provider/child boundaries.',
        'not_covered':['Live model format choices','Native phone/browser layout','Real research-provider responses',
                       'Earlier Defect 6 candidate: sourced charts and delayed side-channel publication'],
        'passed':sum(row['exit']==0 for row in rows),
        'total':len(rows),
        'suites':rows,
    }
    if args.report:
        args.report.parent.mkdir(parents=True,exist_ok=True)
        args.report.write_text(json.dumps(report,indent=2)+'\n')
    return 0 if report['passed']==report['total'] else 1


if __name__=='__main__':
    sys.exit(main())
