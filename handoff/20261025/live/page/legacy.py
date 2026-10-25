"""Exclusive text-lane bridge for the existing /stream reader.

No provider calls, classification call, model-generated progress or title calls.
The renderer receives a presentation envelope only after harness completion.
"""
import asyncio
import base64
import json
import os
import re
import threading
import time
import uuid
from fastapi.responses import JSONResponse,StreamingResponse
from .bootstrap import build_adapter

HEX=re.compile(r'^[0-9a-fA-F]{8,40}$')


def token(conv,turn):return 'page.'+conv+'.'+turn


def unpack(value):
    parts=str(value or '').split('.')
    return (parts[1],parts[2]) if len(parts)==3 and parts[0]=='page' and HEX.fullmatch(parts[1]) and HEX.fullmatch(parts[2]) else None


class TextLane:
    def __init__(self,ns,adapter=None):self.ns=ns;self._adapter=adapter;self.lock=threading.Lock()
    @property
    def adapter(self):
        with self.lock:
            if self._adapter is None:
                import os
                from pathlib import Path
                app=Path(self.ns['HERE'])
                self._adapter=build_adapter(app_dir=str(app),hermes_bin=self.ns['HERMES_BIN'],state_dir=os.environ.get('PRESENT_STORE',str(app/'ctx/page-presentation')))
            return self._adapter
    def owner(self,request):
        # This application is a single-operator dashboard. All full-scope devices
        # authenticate that operator; device cookies are not separate owner IDs.
        if self.ns['auth_scope'](request) not in ('master','full') or not self.ns['same_origin'](request):raise PermissionError('unauthorized')
        return 'operator'
    async def start(self,request,data):
        try:
            owner=self.owner(request);conv=str(data.get('conv') or '');question=str(data.get('q') or '').strip()
            turn=str(data.get('turn_id') or uuid.uuid4().hex)
            if not HEX.fullmatch(conv) or not HEX.fullmatch(turn) or not question or len(question)>self.ns['MAX_QUESTION']:raise ValueError('invalid_page_turn')
            if self.ns['tombstoned'](conv):return JSONResponse({'error':'conversation deleted'},status_code=410)
            # Shape is authored by the harness under its frozen presentation contract.
            # A stricter request-specific resolver can add required states/receipts.
            self.adapter.start(owner,conv,turn,question)
            return self.watch(owner,conv,turn)
        except PermissionError:return JSONResponse({'error':'unauthorized'},status_code=403)
        except ValueError:return JSONResponse({'error':'invalid_page_turn'},status_code=400)
    def watch(self,owner,conv,turn):
        row=self.adapter.read(owner,conv,turn)
        async def events():
            yield self.frame('open',{'turn':token(conv,turn),'tid':turn,'conv':conv,'q':row['request']['question'],'attach':True})
            last_progress=None;last_approval=0;last_steps=0;last_omitted=0
            while True:
                state=self.adapter.snapshot(owner,conv,turn)
                if state['current_progress'] and state['current_progress']['ts']!=last_progress:
                    last_progress=state['current_progress']['ts'];yield self.frame('page_progress',{**state['current_progress'],'conv':conv,'tid':turn})
                rev=state.get('rev') or 0
                omitted=state.get('journal_omitted') or 0
                if omitted>(last_omitted or 0):
                    last_omitted=omitted
                    for step in (state.get('steps') or []):
                        yield self.frame('tool_step',{**step,'conv':conv,'tid':turn,'snapshot':True,'omitted':omitted})
                    last_steps=rev   # the snapshot is authoritative; never replay older transitions
                if rev>last_steps:
                    for step in (state.get('journal') or []):
                        if step.get('rev',0)>last_steps:
                            yield self.frame('tool_step',{**step,'conv':conv,'tid':turn})
                    last_steps=rev
                if state['approval'] and time.monotonic()-last_approval>2:
                    last_approval=time.monotonic();yield self.frame('approval_request',{**state['approval'],'conv':conv,'tid':turn})
                if state['terminal']:
                    terminal={**state['terminal'],'tid':turn}
                    yield self.frame(terminal['event'],terminal)
                    yield self.frame('done',{'conv':conv,'tid':turn,'status':state['status'],'timing':state['timing']})
                    return
                yield ': ping\n\n'
                await asyncio.sleep(.25)
        return StreamingResponse(events(),media_type='text/event-stream',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})
    async def attach(self,request,data):
        try:
            owner=self.owner(request);identity=unpack(data.get('turn'))
            if not identity:raise ValueError()
            return self.watch(owner,*identity)
        except PermissionError:return JSONResponse({'error':'unauthorized'},status_code=403)
        except (ValueError,FileNotFoundError):return JSONResponse({'error':'unknown_page_turn'},status_code=404)
    async def cancel(self,request,data):
        try:
            owner=self.owner(request);identity=unpack(data.get('turn'))
            if not identity:raise ValueError()
            self.adapter.cancel(owner,*identity)
            return JSONResponse({'ok':True})
        except PermissionError:return JSONResponse({'error':'unauthorized'},status_code=403)
        except (ValueError,FileNotFoundError):return JSONResponse({'error':'unknown_page_turn'},status_code=404)
    async def approval(self,request,conv,turn):
        try:
            owner=self.owner(request);data=await request.json()
            if set(data)!={'id','decision'}:raise ValueError()
            return JSONResponse(self.adapter.decide(owner,conv,turn,data['id'],data['decision']))
        except PermissionError:return JSONResponse({'error':'unauthorized'},status_code=403)
        except (ValueError,FileNotFoundError):return JSONResponse({'error':'approval_not_pending'},status_code=409)
    @staticmethod
    def frame(event,data):return 'event: '+event+'\ndata: '+json.dumps(data,ensure_ascii=False)+'\n\n'

    def unavailable(self,data,error_id):
        conv=str(data.get('conv') or '')
        if not HEX.fullmatch(conv):conv=uuid.uuid4().hex
        turn=str(data.get('turn_id') or '')
        if not HEX.fullmatch(turn):turn=uuid.uuid4().hex
        async def events():
            yield self.frame('open',{'turn':token(conv,turn),'tid':turn,'conv':conv,'q':str(data.get('q') or '')})
            yield self.frame('failure',{'id':turn+':terminal','turn':turn,'tid':turn,'conv':conv,'error_id':error_id,'message':'JARVIS could not complete this request. Reference: '+error_id})
            yield self.frame('done',{'conv':conv,'tid':turn,'status':'failed'})
        return StreamingResponse(events(),media_type='text/event-stream',headers={'Cache-Control':'no-store'})

    async def prewarm(self,request):
        try:
            owner=self.owner(request)
            if not self.ns['rate_ok'](request,'page-prewarm'):return JSONResponse({'error':'rate limited'},status_code=429)
            data=await request.json();conv=str(data.get('conv') or '')
            if not HEX.fullmatch(conv) or self.ns['tombstoned'](conv):raise ValueError()
            def work():
                try:self.adapter.prewarm(owner,conv)
                except Exception:
                    import logging
                    logging.getLogger(__name__).exception('page prewarm failed conv=%s',conv)
            threading.Thread(target=work,daemon=True).start()
            return JSONResponse({'queued':True})
        except PermissionError:return JSONResponse({'error':'unauthorized'},status_code=403)
        except ValueError:return JSONResponse({'error':'invalid conversation'},status_code=400)

    def records(self):
        from pathlib import Path
        directory=Path(os.environ.get('PRESENT_STORE',str(Path(self.ns['HERE'])/'ctx/page-presentation')))/'turns'
        rows=[]
        for path in directory.glob('*.json'):
            row=json.loads(path.read_bytes())
            if row.get('owner')=='operator':rows.append(row)
        return rows
    def owns(self,conv):return any(row['conv']==conv for row in self.records())
    def live(self,conv):
        rows=[row for row in self.records() if row['conv']==conv and not row.get('terminal')]
        return min(rows,key=lambda r:r['created_at']) if rows else None
    @staticmethod
    def answer(payload):
        if payload['kind']=='prose':return payload['intro']
        receipt=base64.b64encode(json.dumps(payload.get('receipts',[]),ensure_ascii=False).encode()).decode()
        return payload['intro']+'\n\n```openui\n// jarvis-context: '+receipt+'\n'+payload['program']+'\n```'
    def overlay_history(self):
        # The durable turn records remain authoritative when a browser disappears.
        # This only overlays the existing in-memory view; it starts no title/model work.
        with self.ns['SESSIONS_LOCK']:
            for row in sorted(self.records(),key=lambda r:r['created_at']):
                conv=row['conv']
                if self.ns['tombstoned'](conv):continue
                entry=self.ns['SESSIONS'].setdefault(conv,{'id':conv,'title':((row.get('request') or {}).get('question') or '')[:64],'started':row['created_at'],'updated':row['created_at'],'turns':[]})
                page_row = bool(row.get('steps') or row.get('journal') or row.get('version'))
                if row.get('status')!='ok' and not page_row:continue
                terminal=row.get('terminal') or {};turns=entry.setdefault('turns',[])
                item={'tid':row['turn'],'cid':conv,'q':row['request']['question'],
                      'a':self.answer(terminal['payload']) if (terminal.get('payload')) else (terminal.get('message') or ''),
                      'status':row.get('status'),'errorId':(terminal or {}).get('id'),
                      'steps':[{'call_id':s.get('call_id'),'action':s.get('action'),'status':s.get('status'),'seq':s.get('seq')} for s in (row.get('steps') or [])],
                      'stepsOmitted':row.get('steps_omitted',0),
                      't':row['created_at'],'startedAt':row['created_at'],'ms':(row.get('timing') or {}).get('complete_ms'),'srv':token(conv,row['turn'])}
                existing=next((t for t in turns if t.get('tid')==row['turn']),None)
                if existing:existing.update(item)
                else:turns.append(item)
                entry['updated']=max(entry.get('updated',0),row['created_at'])
