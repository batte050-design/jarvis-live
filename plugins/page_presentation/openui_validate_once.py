"""Installed-app guard plus side-effect-free initial evaluation; bounded child calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def positional_repair(error, schema):
    """Explain the installed component contract, never rewrite submitted code."""
    import re
    hints=[]
    for name, definition in schema.get('$defs',{}).items():
        if not re.search(r'(?<![A-Za-z_0-9])'+re.escape(name)+r'(?:/|:)',error):
            continue
        props=definition.get('properties',{});required=definition.get('required',[])
        if not props:continue
        slots=[]
        for position,(field,spec) in enumerate(props.items(),1):
            kind=' | '.join(map(str,spec['enum'])) if 'enum' in spec else spec.get('type','value')
            if kind=='array':kind='array of '+spec.get('items',{}).get('type','values')
            slots.append(str(position)+' '+field+': '+kind+(' (required)' if field in required else ' (optional)'))
        hints.append(name+' takes at most '+str(len(props))+' positional arguments, in this exact order: '+'; '.join(slots)+'. Use null to skip an optional position before a later argument; omit unused trailing arguments. Do not insert an extra title or shift later arguments. Return a corrected program through emit_ui.')
        if len(hints)==3:break
    return '\n'.join(hints)


def main():
    app = Path(os.environ['PRESENT_APP']).resolve()
    sys.path.insert(0, str(app))
    import response_openui as R
    schema_value=None
    try:
        value = json.load(sys.stdin)
        code = value['program']
        guarded = R.validate(code,value.get('receipts',[]),harness_authored=True)
        code = guarded.get('canonicalCode',code)
        node = R.validator_runtime()
        evaluator = Path(__file__).with_name('evaluate.cjs')
        schema = subprocess.run([node,'--max-old-space-size=128',str(app/'openui/validate.cjs'),'--schema'],capture_output=True,text=True,timeout=8,check=True)
        schema_value=json.loads(schema.stdout)
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
        error=str(exc)[:800]
        try:
            if schema_value is None:
                node=R.validator_runtime()
                schema=subprocess.run([node,'--max-old-space-size=128',str(app/'openui/validate.cjs'),'--schema'],capture_output=True,text=True,timeout=2,check=True)
                schema_value=json.loads(schema.stdout)
            hint=positional_repair(error,schema_value)
            if hint:error+='\n'+hint
        except Exception:
            pass  # Preserve the original rejection if its repair catalogue is unavailable.
        print(json.dumps({'ok':False,'stage':'validate','error':error}))
        return 1


if __name__=='__main__':
    sys.exit(main())
