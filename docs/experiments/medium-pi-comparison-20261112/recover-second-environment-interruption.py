from pathlib import Path
import hashlib,json,os,shutil,signal,subprocess
repo=Path.cwd();root=repo/'.handoff/campaign-v3';source=repo/'docs/experiments/medium-pi-comparison-20261112';oldid='medium-live-v3-anthropic-r1-pi';newid=oldid+'-restart1';rr=root/'runs'/oldid;ledger=root/'wire-live/ledger.json'
a=json.loads(ledger.read_text());own=ledger.parent/'active.lock/owner.json';owner=json.loads(own.read_text());status=(Path('/proc')/str(owner['pid'])/'status').read_text();assert '\nState:\tZ ' in status
assert all(e.get('priced') for e in a if e.get('runId','').startswith('medium-live-v3-'))
kept={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'runs').glob('*/result.json')};assert len(kept)==10 and oldid not in kept
orphans=[]
for p in Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  args=(p/'cmdline').read_bytes().split(b'\0')
  if len(args)<2 or not args[1].decode().endswith('/@earendil-works/pi-coding-agent/dist/cli.js'):continue
  env=dict(v.split(b'=',1) for v in (p/'environ').read_bytes().split(b'\0') if b'=' in v)
  if env.get(b'PI_CODING_AGENT_DIR',b'').decode()!=str(rr/'state/pi'):continue
  pid=int(p.name);assert os.getpgid(pid)==pid;os.killpg(pid,signal.SIGTERM);orphans.append(pid)
 except (FileNotFoundError,ProcessLookupError,PermissionError):pass
workspace=Path(json.loads((rr/'manifest.json').read_text())['workspace']);initial=json.loads((rr/'prepared.json').read_text())['initialFiles'];names=set(initial)
for args in [['git','ls-files','-z'],['git','ls-files','--others','--exclude-standard','-z']]:names.update(v for v in subprocess.run(args,cwd=workspace,capture_output=True,check=True).stdout.decode().split('\0') if v)
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
entries=[e for e in a if e.get('runId')==oldid];assert len(entries)==122
record={'reason':'Second environment startup transition terminated coordinator; owner proven zombie','oldRunId':oldid,'replacementRunId':newid,'requestIds':[e['id'] for e in entries],'meteredUsd':sum(e['priced']['usd'] for e in entries),'unknownUsageRequests':[],'exitCode':None,'agentElapsedMs':None,'stdoutUnavailable':'Coordinator buffered CLI stdout in memory; process was terminated','qualityPass':None,'orphanCliGroupsTerminated':orphans,'noCompletedRunRepeated':True,'retryScheduling':'After all other unstarted cases; subject to remaining approved $30 cap'}
(rr/'environment-interrupted.json').write_text(json.dumps(record,indent=2)+'\n');checkpoint=root/'controller-checkpoints';checkpoint.mkdir(exist_ok=True);shutil.copyfile(own,checkpoint/'second-environment-restart-ledger-owner.json');assert json.loads(own.read_text())==owner;own.unlink();own.parent.rmdir()
script=source/'run.mjs';text=script.read_text();needle='async function fakeProvider() {';assert needle in text;text=text.replace(needle,"// Infrastructure recovery: retain the partial charge and defer only the interrupted case.\nif (live) {\n  const index = plan.findIndex((spec) => spec.id === '"+oldid+"');\n  const [deferred] = plan.splice(index, 1);\n  deferred.id = '"+newid+"';\n  plan.push(deferred);\n}\n\n"+needle,1);script.write_text(text)
protocol=root/'protocol-live.json';before=json.loads(protocol.read_text());after=json.loads(json.dumps(before));index=next(i for i,v in enumerate(after['plan']) if v['id']==oldid);spec=after['plan'].pop(index);spec['id']=newid;after['plan'].append(spec);after['hashes']['run.mjs']=hashlib.sha256(script.read_bytes()).hexdigest();shutil.copyfile(protocol,root/'protocol-live.before-second-environment-restart.json')
lineage={'reason':record['reason'],'oldRunId':oldid,'newRunId':newid,'completedResultSha256':kept,'ledgerSha256':hashlib.sha256(ledger.read_bytes()).hexdigest(),'beforeProtocolSha256':hashlib.sha256(protocol.read_bytes()).hexdigest(),'interruptedAttempt':record,'allowedProtocolChanges':['defer interrupted Anthropic Pi R1 with new execution ID','hashes.run.mjs'],'costAccounting':'All partial charges remain in full-case and campaign totals; original wall time unknown/censored'}
protocol.write_text(json.dumps(after,indent=2)+'\n');lineage['afterProtocolSha256']=hashlib.sha256(protocol.read_bytes()).hexdigest();(root/'environment-resume-lineage-2.json').write_text(json.dumps(lineage,indent=2)+'\n');print(json.dumps({'keptCompleted':len(kept),'partialRequests':len(entries),'partialCost':record['meteredUsd'],'deferredId':newid,'nextCase':after['plan'][10]['id'],'cap':after['capUsd']}))
