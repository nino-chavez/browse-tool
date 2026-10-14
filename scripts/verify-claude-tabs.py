#!/usr/bin/env python3
import os,json,subprocess,selectors,time,uuid,argparse
from pathlib import Path
parser=argparse.ArgumentParser(description='Verify real Claude browser tab reuse across turns and owned cleanup.')
parser.add_argument('--settings',help='Candidate Claude settings; omit to verify the installed user settings')
parser.add_argument('--receipt',required=True,help='Save a compact JSON verification receipt')
args=parser.parse_args()
repo=Path(__file__).resolve().parents[1]
sid=str(uuid.uuid4())
env=dict(os.environ,CLAUDE_GUARD_ROLE='readonly')
for key in ['BROWSE_SESSION','CLAUDE_CODE_SESSION_ID','BROWSE_SHARED_TAB','BROWSE_INCOGNITO','ANTHROPIC_API_KEY']: env.pop(key,None)
cmd=['claude','-p','--session-id',sid,'--input-format','stream-json','--output-format','stream-json','--verbose','--tools','Bash','--allowedTools','Bash(node:*)','--strict-mcp-config','{"mcpServers":{}}','--disable-slash-commands']
if args.settings: cmd += ['--settings',args.settings]
p=subprocess.Popen(cmd,cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);sel.register(p.stderr,selectors.EVENT_READ)
errors=[]
turns=[
 f'Browser verification only. Run exactly this Bash command: node {repo}/bin/browse-nav \"data:text/html,<title>Claude tab round one</title><p>Round one</p>\". Do not set BROWSE_SESSION or CLAUDE_CODE_SESSION_ID. Do not use --new, stop Chrome, or close the tab. Then reply done.',
 f'Same browser task, next turn. Run exactly this Bash command: node {repo}/bin/browse-nav \"data:text/html,<title>Claude tab round two</title><p>Round two</p>\". Do not set identity variables or use --new. Leave the tab open and reply done.',
 f'Browser task finished. Run exactly this Bash command: node {repo}/bin/browse-tabs close-owned. Do not set identity variables or stop Chrome. Then reply done.'
]
leases=Path.home()/'.browse-tool'/'leases'/f'{sid}.json'
checks=[]
def send(text):
 p.stdin.write(json.dumps({'type':'user','message':{'role':'user','content':text}})+'\n');p.stdin.flush()
send(turns[0]);idx=0;deadline=time.time()+240
try:
 while idx<len(turns) and time.time()<deadline:
  for key,_ in sel.select(1):
   line=key.fileobj.readline()
   if not line: continue
   if key.fileobj is p.stderr: errors.append(line);continue
   try: msg=json.loads(line)
   except ValueError: continue
   if msg.get('type')=='result':
    if msg.get('is_error'): raise RuntimeError(msg.get('result',str(msg)))
    if idx<2:
     if not leases.exists(): raise RuntimeError('Claude actual browser call did not create its real-session lease')
     d=json.loads(leases.read_text());checks.append({'turn':idx+1,'targetId':d.get('targetId'),'tabCount':len(d.get('tabs',[]))})
     print(json.dumps(checks[-1]),flush=True)
    else:
     if leases.exists(): raise RuntimeError('Claude cleanup left its lease behind')
     print('Claude actual cleanup removed its lease.',flush=True)
    idx+=1
    if idx<len(turns): send(turns[idx])
  if p.poll() is not None and idx<len(turns): raise RuntimeError('Claude exited before verification finished: '+''.join(errors)[-1000:])
 if idx!=len(turns): raise RuntimeError('Claude browser canary deadline reached')
 assert checks[0]['targetId']==checks[1]['targetId'],checks
 assert all(c['tabCount']==1 for c in checks),checks
 print('PASS: real Claude tool calls reused the same tab across turns and cleaned up at completion.',flush=True)
finally:
 p.stdin.close()
 try: p.wait(timeout=20)
 except subprocess.TimeoutExpired: p.terminate();p.wait(timeout=10)
 Path(args.receipt).write_text(json.dumps({'session_id':sid,'checks':checks,'turns_finished':idx,'exit_code':p.returncode,'passed':idx==3 and len(checks)==2 and checks[0]['targetId']==checks[1]['targetId']},indent=2)+'\n')
 # On failure, remove only this canary session's tabs; never stop shared Chrome.
 if idx!=len(turns): subprocess.run(['node',str(repo/'bin/browse-tabs'),'close-owned'],env=dict(env,BROWSE_SESSION=sid),stdin=subprocess.DEVNULL,capture_output=True,timeout=20)
