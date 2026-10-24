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
    ('supplied-data-publication', [sys.executable,'tests/test_current_repairs.py']),
    ('openui-lang', [sys.executable,'tests/test_openui_lang.py']),
    ('defect6', [sys.executable,'tests/test_defect6.py']),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--browser',type=Path,help='Optional existing Chromium executable for offline native-frame/layout acceptance')
    args = parser.parse_args()
    suites = list(SUITES)
    if args.browser:
        suites.append(('native-browser',['node','tools/native_ui_acceptance.js','--browser',str(args.browser.resolve())]))
        suites.append(('native-openui',['node','tools/native_openui_acceptance.js','--browser',str(args.browser.resolve())]))
    rows = []
    for name,command in suites:
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
            print(row['output'][-6000:],flush=True)
    report = {
        'base':'8c2e433200da23002e0be657e1baacf1e4d5c680',
        'kind':'Offline tests using actual helpers/painter and scripted provider/child boundaries; optional real Chromium.',
        'not_covered':['Human input during a deployed streaming turn','Real STT/TTS and /read audio command',
                       'Unscripted model selection and Lang generation with the deployed provider',
                       'Intermittent agent_empty root cause and external service-restart caller',
                       'Two unnamed layout known failures from acceptance tools not present in this snapshot'],
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
