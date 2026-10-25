#!/usr/bin/env python3
"""Six real-provider text turns against an isolated real app, NEVER the deployed URL.
No fixtures are substituted for Hermes or the provider. Missing access is BLOCKED, not PASS.
"""
import argparse
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

CASES=('single-turn','same-id-retry','same-chat-overlap','different-chat-overlap','reader-reattach','window-moves-on')
SOURCE_FILES=('server.py','warm_agent.py','approvals.py','redact.py','widgets.py','response_layer.py','response-capabilities.json','index.html','index_v1.html','stt_vocab.txt')
SOURCE_DIRS=('static','vendor','persona')


def preflight(binary):
    missing=[name for name in ('fastapi','uvicorn','numpy','yaml') if importlib.util.find_spec(name) is None]
    if not binary or not Path(binary).is_file() or not os.access(binary,os.X_OK):missing.append('real Hermes executable (--hermes-bin)')
    return missing


def copy_source(source,target):
    target.mkdir()
    for name in SOURCE_FILES:
        if (source/name).is_file():shutil.copyfile(source/name,target/name)
    for name in SOURCE_DIRS:
        if (source/name).is_dir():shutil.copytree(source/name,target/name,symlinks=False)
    # No sessions, logs, approvals, context files, tokens or source .env are copied.
    for name in ('logs','ctx','outbox'): (target/name).mkdir(exist_ok=True)


def collect(response):
    rows=[];kind=None
    with response:
        for raw in response:
            line=raw.decode().rstrip('\r\n')
            if line.startswith('event: '):kind=line[7:]
            elif line.startswith('data: ') and kind:
                rows.append((kind,json.loads(line[6:])))
                if kind=='done':break
    return rows


def descendants(pid):
    """Snapshot only our process descendants, including cold agents in their own groups."""
    found=[]
    try:children=Path('/proc',str(pid),'task',str(pid),'children').read_text().split()
    except OSError:return found
    for child in children:
        try:
            ident=Path('/proc',child,'stat').read_text().rsplit(') ',1)[1].split()[19]
            found.append((int(child),ident));found.extend(descendants(int(child)))
        except (OSError,IndexError,ValueError):pass
    return found


def signal_descendants(snapshot,sig):
    for pid,started in reversed(snapshot):
        try:
            current=Path('/proc',str(pid),'stat').read_text().rsplit(') ',1)[1].split()[19]
            if current==started:os.kill(pid,sig)
        except (OSError,IndexError):pass


class IsolatedApp:
    def __init__(self,source,binary,template,model,root):
        self.root,self.source=root,source;self.app=root/'app';self.home=root/'agent';self.home.mkdir();copy_source(source,self.app)
        self.token=secrets.token_urlsafe(32);(self.home/'jarvis_live_token').write_text(self.token);(self.home/'shim_auth_key').write_text(secrets.token_urlsafe(32))
        import yaml
        config=yaml.safe_load((template/'config.yaml').read_text()) or {}
        # Retain provider/model configuration only. Never load operator MCP commands, cron, hooks,
        # plugins, personal memory or app/session state in this dedicated test profile.
        allowed=('model','providers','provider','custom_providers','compression','reasoning')
        config={k:config[k] for k in allowed if k in config}
        if model:config['model']={'default':model}
        if not (config.get('model') or {}).get('default'):raise RuntimeError('isolated profile needs a model')
        (self.home/'config.yaml').write_text(yaml.safe_dump(config))
        if (template/'.env').is_file():shutil.copyfile(template/'.env',self.home/'.env');(self.home/'.env').chmod(0o600)
        self.marker=secrets.token_hex(16);(self.home/'MEMORY.md').write_text('Acceptance private memory marker: '+self.marker+'\n')
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        if self.port in (8150,8151):raise RuntimeError('refusing a production/staging service port')
        self.url='http://127.0.0.1:'+str(self.port)
        env=dict(os.environ);env.update(JARVIS_ACCEPTANCE_ROOT=str(root),JARVIS_ACCEPTANCE_APP=str(self.app),JARVIS_LIVE_PORT=str(self.port),
            JARVIS_HERMES_HOME=str(self.home),JARVIS_LIVE_AGENT_HOME=str(self.home),HERMES_HOME=str(self.home),HOME=str(self.home),
            TMPDIR=str(root),PYTHONDONTWRITEBYTECODE='1',JARVIS_HERMES_BIN=str(binary),HERMES_BIN=str(binary))
        self.log=(root/'service.log').open('w');self.proc=subprocess.Popen([sys.executable,str(Path(__file__).with_name('acceptance_server.py'))],cwd=root,env=env,stdout=self.log,stderr=subprocess.STDOUT,start_new_session=True)
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            if self.proc.poll() is not None:raise RuntimeError('isolated app failed to start; see private service log')
            try:
                self.request('/api/chat/'+'a'*32+'/turnopts');break
            except (OSError,urllib.error.URLError):time.sleep(.1)
        else:raise RuntimeError('isolated app startup timeout')

    def request(self,path,body=None,stream=False):
        # Callers cannot select a deployment origin or alternate host.
        if not path.startswith('/') or path.startswith('//'):raise ValueError('relative app route required')
        req=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body).encode(),headers={'Cookie':'jl='+self.token,'Origin':self.url,'Content-Type':'application/json','Accept':'text/event-stream' if stream else 'application/json'})
        response=urllib.request.urlopen(req,timeout=180)
        if stream:return response
        with response:return json.load(response)

    def turn(self,conv,tid,token,*,long=False):
        instruction=('Write the numbers 1 through 300, then end with exactly '+token if long else 'Reply with exactly '+token)
        # Explicit reasoning forces the real agent; this must not silently test the fast-only path.
        return self.request('/stream',{'q':instruction,'mode':'text','reasoning':'low','conv':conv,'turn_id':tid},stream=True)

    def open_turn(self,conv,tid,token,long=False):
        response=self.turn(conv,tid,token,long=long);prefix=[];kind=None
        for raw in response:
            line=raw.decode().rstrip('\r\n')
            if line.startswith('event: '):kind=line[7:]
            elif line.startswith('data: ') and kind:
                data=json.loads(line[6:]);prefix.append((kind,data))
                if kind=='open':return response,prefix,data
                if kind=='done':raise AssertionError('turn ended before open')
        raise AssertionError('missing open event')

    def answer(self,rows,token):
        assert not [d for k,d in rows if k in ('err','warnerr')], 'turn produced an error'
        settled=[str(d.get('text') or '') for k,d in rows if k=='text']
        assert settled and token in settled[-1], 'missing settled answer/token'
        assert any(k=='done' for k,d in rows), 'turn was dropped'
        assert not any(k=='audio' for k,d in rows), 'text turn emitted audio'
        return settled[-1]

    def stored(self,conv,token):
        data=self.request('/api/sessions/'+conv)
        hits=[t for t in data.get('turns',[]) if token in str(t.get('a',''))]
        assert len(hits)==1, 'answer absent, duplicated or in the wrong conversation'
        return data

    def close(self):
        if getattr(self,'proc',None) and self.proc.poll() is None:
            children=descendants(self.proc.pid)
            signal_descendants(children,signal.SIGTERM)
            os.killpg(self.proc.pid,signal.SIGTERM)
            try:self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(self.proc.pid,signal.SIGKILL);self.proc.wait(timeout=5)
            signal_descendants(children,signal.SIGKILL)
        if getattr(self,'log',None):self.log.close()


def run_case(app,name):
    a,b=secrets.token_hex(16),secrets.token_hex(16);ta,tb=secrets.token_hex(16),secrets.token_hex(16)
    va,vb='ACCEPT_'+secrets.token_hex(12),'ACCEPT_'+secrets.token_hex(12)
    if name=='single-turn':
        rows=collect(app.turn(a,ta,va));app.answer(rows,va);app.stored(a,va)
    elif name=='same-id-retry':
        first=collect(app.turn(a,ta,va));second=collect(app.turn(a,ta,va));assert app.answer(first,va)==app.answer(second,va);app.stored(a,va)
        turns=app.request('/api/turns/events?conv='+a+'&tid='+ta).get('records',[]);assert len(turns)==1,'retry created another execution'
    elif name=='same-chat-overlap':
        response,prefix,_=app.open_turn(a,ta,va,long=True)
        try:
            try:
                unexpected=app.turn(a,tb,vb);unexpected.close();raise AssertionError('overlapping same-chat turn was accepted')
            except urllib.error.HTTPError as e:assert e.code==409, 'overlap did not return 409'
            app.answer(prefix+collect(response),va);app.stored(a,va)
        finally:response.close()
    elif name=='different-chat-overlap':
        response,prefix,_=app.open_turn(a,ta,va,long=True)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            first=pool.submit(lambda:prefix+collect(response));second=pool.submit(lambda:collect(app.turn(b,tb,vb)))
            app.answer(first.result(),va);app.answer(second.result(),vb)
        da,db=app.stored(a,va),app.stored(b,vb);assert vb not in json.dumps(da) and va not in json.dumps(db),'conversation contamination'
    elif name=='reader-reattach':
        response,prefix,opened=app.open_turn(a,ta,va,long=True);response.close()
        rows=collect(app.request('/stream/attach',{'conv':a,'turn':opened['turn'],'since':0},stream=True));app.answer(rows,va);app.stored(a,va)
    elif name=='window-moves-on':
        response,prefix,_=app.open_turn(a,ta,va,long=True)
        app.request('/reset',{})
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            first=pool.submit(lambda:prefix+collect(response));second=pool.submit(lambda:collect(app.turn(b,tb,vb)))
            app.answer(first.result(),va);app.answer(second.result(),vb)
        da,db=app.stored(a,va),app.stored(b,vb);assert vb not in json.dumps(da) and va not in json.dumps(db),'window move wrote into another conversation'
    else:raise ValueError(name)


def main():
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1]);p.add_argument('--hermes-bin',type=Path);p.add_argument('--agent-home-template',type=Path);p.add_argument('--model');p.add_argument('--output',type=Path,required=True);p.add_argument('--keep-private-state',action='store_true');args=p.parse_args()
    source=args.source.resolve();binary=args.hermes_bin.resolve() if args.hermes_bin else None;output=args.output.resolve()
    if source==output or source in output.parents:raise SystemExit('report must be outside the source/deployed app tree')
    missing=preflight(binary)
    if not args.agent_home_template or not (args.agent_home_template/'config.yaml').is_file():missing.append('explicit isolated agent-home template/config.yaml')
    rows=[];root=Path(tempfile.mkdtemp(prefix='jarvis-agent-acceptance-'));app=None
    try:
        if not missing:
            try:
                app=IsolatedApp.__new__(IsolatedApp)
                app.__init__(source,binary,args.agent_home_template.resolve(),args.model,root)
            except Exception as e:missing.append(str(e))
        for name in CASES:
            if missing:rows.append({'case':name,'status':'BLOCKED','reason':'; '.join(missing)});continue
            try:run_case(app,name);rows.append({'case':name,'status':'PASS'})
            except Exception as e:rows.append({'case':name,'status':'FAIL','reason':str(e)[:500]})
    finally:
        if app:app.close()
    report={'kind':'real Hermes/provider acceptance; no protocol fixtures','source':str(source),'cases':rows,'private_state_kept':args.keep_private_state}
    if args.keep_private_state:report['private_state_path']=str(root)
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
    if not args.keep_private_state:shutil.rmtree(root)
    return 2 if any(r['status']=='BLOCKED' for r in rows) else int(any(r['status']!='PASS' for r in rows))

if __name__=='__main__':raise SystemExit(main())
