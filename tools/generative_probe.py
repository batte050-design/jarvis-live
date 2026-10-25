#!/usr/bin/env python3
"""Record actual staging answers, timings and server verdicts; or replay existing wire evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import secrets
import time
import urllib.request
import urllib.parse
import urllib.error

from generative_evidence import read_sse,summarise,analyse_answer,write_answers,cancellation_payload


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base');p.add_argument('--cookie-file',type=Path)
    p.add_argument('--cases',type=Path,default=Path(__file__).resolve().parents[1]/'tests/fixtures/generative30.json')
    p.add_argument('--report',type=Path,required=True);p.add_argument('--limit',type=int,default=30)
    p.add_argument('--deadline',type=float,default=45);p.add_argument('--allow-cancel',action='store_true')
    p.add_argument('--replay',type=Path,help='Reconstruct an existing JSON report without a model call or credential')
    a=p.parse_args()
    def save(report):
        a.report.parent.mkdir(parents=True,exist_ok=True)
        a.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        write_answers(report,a.report.with_suffix('.answers.md'))
    if a.replay:
        report=json.loads(a.replay.read_text());report['replayed_from']=a.replay.name
        for row in report.get('results',report.get('rows',[])):
            if 'errors' in row:row['original_recorder_errors']=row['errors']
            if isinstance(row.get('events'),list):row.update(summarise(row['events']))
            else:row.update(analyse_answer(row.get('text',row.get('answer',''))),server_status='unknown',status_source='no recorded server verdict')
        save(report);return 0
    if not a.base or not a.cookie_file:p.error('--base and --cookie-file required unless replaying')
    base=a.base.rstrip('/');address=urllib.parse.urlsplit(base)
    if address.scheme!='https' or address.netloc!='stage.battemohammad.com' or address.path:p.error('this probe is staging-only')
    cookie=a.cookie_file.read_text().strip()
    if not cookie.startswith('jl=') or '\n' in cookie or '\r' in cookie:p.error('expected one jl cookie')
    headers={'Cookie':cookie,'Origin':base,'Accept':'application/json'}
    def request(path,data=None,timeout=20):
        body=None if data is None else json.dumps(data).encode()
        return urllib.request.urlopen(urllib.request.Request(base+path,data=body,headers={**headers,'Content-Type':'application/json'}),timeout=timeout)
    def get(path):
        with request(path) as response:return json.load(response)
    cases=json.loads(a.cases.read_text())['cases'][:a.limit]
    try:validator=get('/api/openui/health')
    except urllib.error.HTTPError as exc:
        try:validator=json.load(exc)
        except ValueError:validator={'ok':False,'error':'preflight HTTP '+str(exc.code)}
    if not validator.get('ok'):
        save({'kind':'Staging validator preflight failed; no model turn sent.','validator':validator,'results':[]})
        print('Validator preflight failed: '+str(validator.get('error')),flush=True);return 2
    build=get('/build');report={'kind':'Actual authenticated staging model answers; browser rendering not asserted.','base':base,'build':build,'validator':validator,'cases_sha256':hashlib.sha256(a.cases.read_bytes()).hexdigest(),'results':[]}
    wire_dir=a.report.parent/(a.report.stem+'-wire');wire_dir.mkdir(parents=True,exist_ok=True)
    for case in cases:
        if get('/build')['js']!=build['js']:report['stopped']='build changed';save(report);break
        if get('/healthz').get('turns',0):report['stopped']='another staging turn is running';save(report);break
        conv=secrets.token_hex(16);row={**case,'conv':conv,'events':[]};started=time.monotonic();opened=None;wire=[];expired=False
        try:
            with request('/stream',{'q':case['question'],'conv':conv,'mode':'text'},timeout=a.deadline+5) as response:
                if 'text/event-stream' not in response.headers.get('Content-Type',''):raise ValueError('not an SSE response')
                def lines():
                    size=0
                    for raw in response:
                        size+=len(raw)
                        if size>4*1024*1024:raise ValueError('wire evidence too large')
                        wire.append(raw);yield raw
                for event in read_sse(lines()):
                    row['events'].append(event)
                    if event['event']=='open':opened=event['data']
                    if event['event']=='done':break
                    if time.monotonic()-started>a.deadline:expired=True;break
        except Exception as exc:row['transport_error']=type(exc).__name__
        row.update(summarise(row['events']));row['seconds']=round(time.monotonic()-started,3)
        row['timed_out']=expired or not row['finished'];row['wire_file']=wire_dir.name+'/'+case['id']+'.sse'
        (wire_dir/(case['id']+'.sse')).write_bytes(b''.join(wire))
        if row['timed_out'] and opened and a.allow_cancel:
            payload=cancellation_payload(opened,{'conv':conv,'mode':'text'})
            if payload:
                try:
                    with request('/cancel',payload) as response:row['cancel_response']=json.load(response)
                except Exception as exc:row['cancel_error']=type(exc).__name__
            else:row['cancel_skipped']='no verified conversation and turn id; no stop sent'
        report['results'].append(row);save(report)
        print(case['id']+' '+row['server_status']+' '+str(row['seconds'])+'s kind='+row['answer_kind']+' programs='+str(row['declared_openui']),flush=True)
        if row['timed_out']:
            report['stopped']='incomplete turn; no further requests sent';save(report);break
    return 0 if len(report['results'])==len(cases) and all(r['finished'] and r['server_status']=='ok' and not r.get('transport_error') for r in report['results']) else 1


if __name__=='__main__':raise SystemExit(main())
