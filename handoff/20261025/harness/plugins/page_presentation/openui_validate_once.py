"""Installed-app guard plus side-effect-free initial evaluation; bounded child calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    app = Path(os.environ['PRESENT_APP']).resolve()
    sys.path.insert(0, str(app))
    import response_openui as R
    try:
        value = json.load(sys.stdin)
        code = value['program']
        guarded = R.validate(code,value.get('receipts',[]))
        code = guarded.get('canonicalCode',code)
        node = R.validator_runtime()
        evaluator = Path(__file__).with_name('evaluate.cjs')
        schema = subprocess.run([node,'--max-old-space-size=128',str(app/'openui/validate.cjs'),'--schema'],capture_output=True,text=True,timeout=8,check=True)
        schema_hash=hashlib.sha256(schema.stdout.strip().encode()).hexdigest()
        run = subprocess.run([node,'--max-old-space-size=128',str(evaluator)],
                             input=json.dumps({'code':code,'receipts':value.get('receipts',[]),'schemaSha256':schema_hash}),capture_output=True,text=True,timeout=8)
        result = json.loads(run.stdout)
        if run.returncode or not result.get('ok'):
            raise ValueError(result.get('error','initial_evaluation_failed'))
        result['canonicalCode']=code
        print(json.dumps(result,allow_nan=False))
        return 0
    except Exception as exc:
        print(json.dumps({'ok':False,'stage':'validate','error':str(exc)[:800]}))
        return 1


if __name__=='__main__':
    sys.exit(main())
