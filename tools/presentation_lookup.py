#!/usr/bin/env python3
"""Run using the existing Hermes interpreter/home. No chat, terminal tool or session is created."""
import asyncio
import inspect
import json
import sys


def main():
    try:
        from tools.web_tools import web_search_tool,web_extract_tool
        if '--probe' in sys.argv:
            print(json.dumps({'search_signature':str(inspect.signature(web_search_tool)),
                              'extract_signature':str(inspect.signature(web_extract_tool)),
                              'module':inspect.getfile(web_search_tool)}));return 0
        raw=sys.stdin.read(8193)
        if len(raw)>8192:raise ValueError('read request too large')
        request=json.loads(raw);name=request['tool'];args=request['arguments']
        if name=='web_search' and set(args)=={'query'}:
            value=web_search_tool(query=args['query'],limit=5)
        elif name=='web_extract' and set(args)=={'urls'}:
            value=web_extract_tool(urls=args['urls'])
        else:raise ValueError('unknown read tool')
        if inspect.isawaitable(value):value=asyncio.run(value)
        if isinstance(value,str):value=json.loads(value)
        if not isinstance(value,(dict,list)):raise ValueError('invalid read result')
        if isinstance(value,dict) and (value.get('error') or value.get('success') is False or value.get('status')=='error'):
            raise ValueError('public backend did not return evidence')
        encoded=json.dumps(value,ensure_ascii=False)
        if len(encoded)>32000:encoded=json.dumps({'text':encoded[:30000],'truncated':True})
        print('JARVIS_READ_RESULT='+json.dumps({'ok':True,'data':json.loads(encoded)}));return 0
    except Exception:
        print('JARVIS_READ_RESULT='+json.dumps({'ok':False}));return 1


if __name__=='__main__':sys.exit(main())
