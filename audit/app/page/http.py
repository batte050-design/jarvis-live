"""Installable ASGI transport. Authentication and contract derivation stay server-owned."""
import asyncio
import json
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse


def router(adapter, authorize, derive_contract):
    """authorize(request) -> stable owner id; raises before any state allocation.

    derive_contract(owner, conv, question) -> trusted required/allowed_kinds/receipts.
    Do not pass client-authored requirements, tool grants or receipts through here.
    """
    api=APIRouter()

    def owner(request):
        value=authorize(request)
        if not isinstance(value,str) or not value:
            raise HTTPException(403,'unauthorized')
        return value

    async def body(request):
        try:
            value=await request.json()
            if not isinstance(value,dict):raise ValueError()
            return value
        except (ValueError,UnicodeError):
            raise HTTPException(400,'invalid_json') from None

    def snapshot(who,conv,turn):
        try:return adapter.snapshot(who,conv,turn)
        except FileNotFoundError:raise HTTPException(404,'unknown_turn') from None
        except ValueError:raise HTTPException(400,'invalid_turn') from None

    @api.post('/api/page/turns')
    async def start(request:Request):
        who=owner(request);data=await body(request)
        if set(data)!={'conv','turn','question'}:raise HTTPException(400,'invalid_fields')
        try:
            contract=derive_contract(who,data['conv'],data['question'])
            return adapter.start(who,data['conv'],data['turn'],data['question'],**contract)
        except (ValueError,KeyError):raise HTTPException(400,'invalid_turn_or_contract') from None

    @api.get('/api/page/turns/{conv}/{turn}')
    async def get(request:Request,conv:str,turn:str):
        return snapshot(owner(request),conv,turn)

    @api.post('/api/page/turns/{conv}/{turn}/cancel')
    async def cancel(request:Request,conv:str,turn:str):
        who=owner(request);snapshot(who,conv,turn)
        adapter.cancel(who,conv,turn)
        return {'ok':True}

    @api.post('/api/page/turns/{conv}/{turn}/approval')
    async def decide(request:Request,conv:str,turn:str):
        who=owner(request);snapshot(who,conv,turn);data=await body(request)
        if set(data)!={'id','decision'}:raise HTTPException(400,'invalid_fields')
        try:return adapter.decide(who,conv,turn,data['id'],data['decision'])
        except PermissionError:raise HTTPException(403,'approval_not_owned') from None
        except ValueError:raise HTTPException(409,'approval_not_pending') from None

    @api.get('/api/page/turns/{conv}/{turn}/events')
    async def events(request:Request,conv:str,turn:str):
        who=owner(request);snapshot(who,conv,turn)
        async def generate():
            seen_progress=seen_approval=None
            while True:
                # Reader disconnection never cancels the worker or changes terminal state.
                if await request.is_disconnected():return
                row=adapter.snapshot(who,conv,turn)
                ev=row['current_progress']
                if ev and ev['ts']!=seen_progress:
                    seen_progress=ev['ts'];yield frame('progress',ev)
                approval=row['approval']
                if approval and approval['id']!=seen_approval:
                    seen_approval=approval['id'];yield frame('approval_request',approval)
                if row['terminal']:
                    terminal=row['terminal']
                    # At-least-once transport. Stable ID + page upsert prevents duplicates.
                    yield frame(terminal['event'],terminal,terminal['id'])
                    yield frame('end',{'turn':turn,'conv':conv,'status':row['status'],'timing':row['timing']},turn+':end')
                    return
                yield ': keepalive\n\n'
                await asyncio.sleep(.25)
        return StreamingResponse(generate(),media_type='text/event-stream',headers={'Cache-Control':'no-store','X-Accel-Buffering':'no'})

    return api


def frame(event,data,event_id=None):
    return (('id: '+event_id+'\n') if event_id else '')+'event: '+event+'\ndata: '+json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n\n'
