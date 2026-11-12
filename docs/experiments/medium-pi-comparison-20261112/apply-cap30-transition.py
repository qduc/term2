"""Apply an authorized cap-only lineage update at a settled coordinator boundary."""
from pathlib import Path
import hashlib,json,os,shutil
repo=Path.cwd();root=repo/'.handoff/campaign-v3';source=repo/'docs/experiments/medium-pi-comparison-20261112'
ledger=root/'wire-live/ledger.json'
if (ledger.parent/'active.lock').exists():raise RuntimeError('Coordinator still owns ledger; wait for natural checkpoint')
a=json.loads(ledger.read_text())
if any(e.get('runId','').startswith('medium-live-v3-') and not e.get('priced') for e in a):raise RuntimeError('Unsettled primary usage; inspect first')
marker=root/'runs/medium-live-v3-openai-r1-pi/started.json'
m=json.loads(marker.read_text())
if not m.get('controllerPauseSentinel') or not m.get('agentWasNotStarted'):raise RuntimeError('Not the explicit unstarted administrative pause')
old=root/'protocol-live.json';before=json.loads(old.read_text())
if before['capUsd']!=15:raise RuntimeError('Wrong transition source')
for name in ['grade.py','prepare.py','task.md']:
 if hashlib.sha256((source/name).read_bytes()).hexdigest()!=before['hashes'][name]:raise RuntimeError('Task/grader changed')
new=json.loads(json.dumps(before));new['capUsd']=30
for name in ['run.mjs','budget-gateway.mjs']:new['hashes'][name]=hashlib.sha256((source/name).read_bytes()).hexdigest()
kept={p.parent.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (root/'runs').glob('*/result.json')}
if set(kept)!={'medium-live-v3-openai-r1-t2'}:raise RuntimeError('Unexpected completed set; inspect before transition')
(root/'controller-checkpoints').mkdir(exist_ok=True)
shutil.copyfile(marker,root/'controller-checkpoints/cap30-unstarted-pause.json')
shutil.copyfile(old,root/'protocol-live.cap15.json')
new_bytes=(json.dumps(new,indent=2)+'\n').encode()
lineage={'authorization':'User: new budget: $30','administrativeOnly':True,'beforeProtocolSha256':hashlib.sha256(old.read_bytes()).hexdigest(),'afterProtocolSha256':hashlib.sha256(new_bytes).hexdigest(),'beforeCapUsd':15,'afterCapUsd':30,'keptResultSha256':kept,'ledgerRowsBefore':len(a),'ledgerSha256Before':hashlib.sha256(ledger.read_bytes()).hexdigest(),'allowedChanges':['capUsd','hashes.run.mjs','hashes.budget-gateway.mjs'],'codingPromptRubricModelsQuotaOrderingUnchanged':True}
(root/'protocol-lineage.json').write_text(json.dumps(lineage,indent=2)+'\n')
old.write_bytes(new_bytes)
marker.unlink()
print(json.dumps(lineage))
