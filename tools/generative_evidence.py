"""Shared wire/answer evidence for API and browser probes. No inferred success from missing UI."""
import json
from pathlib import Path
import re
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import response_openui as O


def read_sse(lines):
    """Parse complete SSE messages, including CRLF, comments and multiline data."""
    event='message';data=[]
    def message():
        if not data:return None
        value=json.loads('\n'.join(data))
        if not isinstance(value,dict):raise ValueError('SSE event payload must be an object')
        return {'event':event,'data':value}
    for raw in lines:
        line=(raw.decode('utf-8') if isinstance(raw,bytes) else raw).rstrip('\r\n')
        if not line:
            value=message()
            if value is not None:yield value
            event='message';data=[];continue
        if line.startswith(':'):continue
        field,_,value=line.partition(':')
        if value.startswith(' '):value=value[1:]
        if field=='event':event=value
        elif field=='data':data.append(value)
    value=message()
    if value is not None:yield value


def cancellation_payload(opened,request):
    if not isinstance(opened,dict) or not isinstance(request,dict):return None
    if request.get('mode')!='text' or not re.fullmatch(r'[a-fA-F0-9]{32}',str(request.get('conv') or '')):return None
    if opened.get('conv')!=request['conv']:return None
    tid=opened.get('tid')
    if not isinstance(tid,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,128}',tid):return None
    if request.get('tid') and request['tid']!=tid:return None
    return {'tid':tid}


def analyse_answer(text):
    programs=[];code_blocks=[];at=0
    while match:=O.FENCES.search(text,at):
        close=re.compile(r'^'+re.escape(match[1][0])+r'{'+str(len(match[1]))+r',}[ \t]*(?:\n|$)',re.M).search(text,match.end())
        end=close.end() if close else len(text);body=text[match.end():close.start() if close else len(text)];tag=match[2].strip()
        if tag in ('openui','openui-lang'):
            try:receipts,code=O.unpack(body)
            except (ValueError,TypeError):receipts,code=[],body
            programs.append({'language':tag,'closed':bool(close),'code':code,'receipts':receipts})
        else:
            code_blocks.append({'language':tag,'closed':bool(close),'code':body,
                                'unlabelled_openui':not tag and bool(re.search(r'(?m)^root\s*=\s*[A-Z]\w*\(',body))})
        at=end
    unlabelled=sum(b['unlabelled_openui'] for b in code_blocks)
    kind='openui' if programs else 'unlabelled_openui' if unlabelled else 'code' if code_blocks else 'prose'
    return {'answer_kind':kind,'declared_openui':len(programs),'programs':programs,'code_blocks':code_blocks,'unlabelled_openui':unlabelled}


def summarise(events):
    text='';provisional='';revisions=[];done=None;legacy_partial=None;errors=[];agent=False;diagnostics=[];validation=[]
    for item in events:
        event=item['event'];data=item['data']
        if event=='tok' and isinstance(data.get('d'),str):text+=data['d'];provisional+=data['d']
        if event=='text' and isinstance(data.get('text'),str):
            text=data['text'];revisions.append(text)
        if event=='note' and isinstance(data.get('partial'),bool):legacy_partial=data['partial']
        if event=='err':errors.append(data.get('type') or 'server error')
        if event=='done':done=data
        for value in data.get('presentation_errors') or []:
            if value not in validation:validation.append(value)
        for value in data.get('presentation_diagnostics') or []:
            if value not in diagnostics:diagnostics.append(value)
        if event=='work' and data.get('state')=='start':agent=True
    explicit=(done or {}).get('status')
    if explicit in ('ok','partial','failed','cancelled'):status=explicit;status_source='done.status'
    elif errors:status='failed';status_source='err event'
    elif legacy_partial is not None:status='partial' if legacy_partial else 'ok';status_source='legacy explicit note.partial'
    else:status='unknown';status_source='no server verdict (not inferred from absence)'
    issues=[]
    if status in ('partial','failed','cancelled'):issues.append('server status: '+status)
    if done is None:issues.append('no terminal done event')
    return {'text':text,'provisional_text':provisional,'text_revisions':revisions,'finished':done is not None,
            'server_status':status,'status_source':status_source,'legacy_partial_signal':legacy_partial,
            'presentation_errors':validation,'presentation_diagnostics':diagnostics,
            'agent_started':agent,'errors':issues,**analyse_answer(text)}


def write_answers(report,path):
    rows=report.get('results',report.get('rows',[]));out=['# Actual model answers','',report.get('kind',''),'',
        'Build: '+json.dumps(report.get('build',{})), '']
    for row in rows:
        text=row.get('text',row.get('answer',''));runs=re.findall(r'`+',text);fence='`'*max(4,1+max(map(len,runs),default=0))
        out.extend(['## '+row['id']+' — '+row.get('category',''),'',row.get('question',''),'',
                    'Seconds: '+str(row.get('model_seconds',row.get('seconds','unknown')))+'; server status: '+row.get('server_status','unknown')+
                    '; answer kind: '+row.get('answer_kind','unknown')+'; provenance: '+row.get('provenance','captured /stream answer')+'.',
                    'Timing source: '+row.get('timing_source','send to /stream completion')+'.','',
                    fence+'text',text,fence,''])
    Path(path).write_text('\n'.join(out),encoding='utf-8')


if __name__=='__main__':
    value=json.load(sys.stdin);events=list(read_sse(value['wire'].splitlines(keepends=True))) if 'wire' in value else value['events']
    print(json.dumps({'events':events,**summarise(events)},ensure_ascii=False))
