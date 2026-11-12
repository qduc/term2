from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess
repo=Path.cwd();root=repo/'.handoff/campaign-v3';source=repo/'docs/experiments/medium-pi-comparison-20261112';oldid='medium-live-v3-openai-r5-pi';newid=oldid+'-restart1';rr=root/'runs'/oldid
ledger=root/'wire-live/ledger.json';entries=json.loads(ledger.read_text());own=ledger.parent/'active.lock/owner.json';owner=json.loads(own.read_text());status=(Path('/proc')/str(owner['pid'])/'status').read_text();assert '\nState:\tZ ' in status,'Old coordinator is not proven dead'
assert all(e.get('priced') for e in entries if e.get('runId','').startswith('medium-live-v3-')),'Unsettled primary request; stop'
completed={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'runs').glob('*/result.json')};assert len(completed)==9 and oldid not in completed
state=str(rr/'state/pi');orphans=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  args=(p/'cmdline').read_bytes().split(b'\0')
  if len(args)<2 or not args[1].decode().endswith('/@earendil-works/pi-coding-agent/dist/cli.js'):continue
  env=dict(x.split(b'=',1) for x in (p/'environ').read_bytes().split(b'\0') if b'=' in x)
  if env.get(b'PI_CODING_AGENT_DIR',b'').decode()!=state:continue
  pid=int(p.name);assert os.getpgid(pid)==pid;os.killpg(pid,signal.SIGTERM);orphans.append(pid)
 except (FileNotFoundError,ProcessLookupError,PermissionError):pass
workspace=Path(json.loads((rr/'manifest.json').read_text())['workspace']);initial=json.loads((rr/'prepared.json').read_text())['initialFiles'];names=set(initial)
for args in [['git','ls-files','-z'],['git','ls-files','--others','--exclude-standard','-z']]:
 p=subprocess.run(args,cwd=workspace,capture_output=True,check=True);names.update(x for x in p.stdout.decode().split('\0') if x)
manifest={}
for name in sorted(names):
 f=workspace/name
 if f.is_symlink():manifest[name]={'symlink':os.readlink(f)}
 elif not f.exists():manifest[name]=None
 elif f.is_file():
  value=hashlib.sha256(f.read_bytes()).hexdigest();manifest[name]=value
  if initial.get(name)!=value:
   dest=rr/'interrupted-candidate-files'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(f,dest)
(rr/'interrupted-candidate-source.json').write_text(json.dumps(manifest,indent=2)+'\n')
requests=[e for e in entries if e.get('runId')==oldid];assert len(requests)==11
record={'reason':'Environment restart terminated coordinator; owner proven zombie; unfinished agent attempt','oldRunId':oldid,'replacementRunId':newid,'requestIds':[e['id'] for e in requests],'meteredUsd':sum(e['priced']['usd'] for e in requests),'unknownUsageRequests':[],'exitCode':None,'agentElapsedMs':None,'stdoutUnavailable':'Coordinator buffered CLI stdout in memory; process was terminated','qualityPass':False,'orphanCliGroupsTerminated':orphans,'noCompletedRunRepeated':True}
(rr/'environment-interrupted.json').write_text(json.dumps(record,indent=2)+'\n')
checkpoint=root/'controller-checkpoints';checkpoint.mkdir(exist_ok=True);shutil.copyfile(own,checkpoint/'environment-restart-ledger-owner.json')
assert json.loads(own.read_text())==owner;own.unlink();own.parent.rmdir()
script=source/'run.mjs';text=script.read_text();needle='async function fakeProvider() {';assert needle in text
text=text.replace(needle,"// Preserve the interrupted attempt; only this unfinished case gets a fresh execution ID.\nfor (const spec of plan) if (live && spec.id === '"+oldid+"') spec.id = '"+newid+"';\n\n"+needle,1);script.write_text(text)
protocol=root/'protocol-live.json';before=json.loads(protocol.read_text());after=json.loads(json.dumps(before));matched=[x for x in after['plan'] if x['id']==oldid];assert len(matched)==1;matched[0]['id']=newid;after['hashes']['run.mjs']=hashlib.sha256(script.read_bytes()).hexdigest();shutil.copyfile(protocol,root/'protocol-live.before-environment-restart.json')
lineage={'reason':record['reason'],'oldRunId':oldid,'newRunId':newid,'completedResultSha256':completed,'ledgerSha256':hashlib.sha256(ledger.read_bytes()).hexdigest(),'beforeProtocolSha256':hashlib.sha256(protocol.read_bytes()).hexdigest(),'interruptedAttempt':record,'costAccounting':'Keep original partial execution and cost; report its retry cost alongside the replacement and in full campaign totals','allowedProtocolChanges':['plan[r5,pi].id','hashes.run.mjs']}
protocol.write_text(json.dumps(after,indent=2)+'\n');lineage['afterProtocolSha256']=hashlib.sha256(protocol.read_bytes()).hexdigest();(root/'environment-resume-lineage.json').write_text(json.dumps(lineage,indent=2)+'\n');print(json.dumps({'completedKept':len(completed),'interruptedRequestsRetained':len(requests),'interruptedMeteredUsd':record['meteredUsd'],'newRunId':newid,'capUsd':after['capUsd']}))
