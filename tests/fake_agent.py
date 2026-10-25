#!/usr/bin/env python3
"""Protocol/process fixture, NOT Hermes and NOT a model-provider acceptance test."""
import json
import os
from pathlib import Path
import signal
import sys

root = Path(os.environ.get('JARVIS_FIXTURE_TRACE', os.getcwd()))
root.mkdir(parents=True, exist_ok=True)
scenario = (root/'scenario').read_text().strip() if (root/'scenario').exists() else 'ok'

def trace(event, **data):
    with (root/'trace.jsonl').open('a') as stream:
        stream.write(json.dumps({'event':event,'pid':os.getpid(),**data})+'\n')

def send(value):
    print(json.dumps(value), flush=True)

trace('start', argv=sys.argv[1:2])
if sys.argv[1:2] == ['acp']:
    for raw in sys.stdin:
        message=json.loads(raw); method=message.get('method'); request=message.get('id')
        if method=='session/new':
            if scenario=='build-refusal':
                send({'id':request,'error':{'code':-1,'message':'fixture provider refused session'}})
            else:
                trace('built');send({'id':request,'result':{'sessionId':'fixture-session'}})
        elif method=='session/prompt':
            ctx=Path(os.environ.get('JARVIS_WEB_CTX',''))
            context=json.loads(ctx.read_text()) if ctx.is_file() else {}
            trace('prompt',guard_context_present=bool(context.get('JARVIS_APPROVAL_SECRET')),chat=context.get('JARVIS_WEB_CHAT'),prompt=message['params']['prompt'][0]['text'])
            send({'method':'session/update','params':{'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'<<<SPOKEN\nFixture answer.\nSPOKEN>>>'}}}})
            send({'id':request,'result':{'stopReason':'end_turn'}})
        else: send({'id':request,'result':{}})
else:
    trace('cold')
    if scenario=='kill':
        send({'type':'text','text':'<<<SPOKEN\nPartial answer before failure. '})
        os.kill(os.getpid(),signal.SIGKILL)
    elif scenario=='provider-refusal':
        send({'type':'result','text':'The provider refused this request.','is_error':True})
    elif scenario=='error-event':
        send({'type':'error','message':'fixture provider refused'})
    else: send({'type':'result','text':'<<<SPOKEN\nFixture answer.\nSPOKEN>>>'})
