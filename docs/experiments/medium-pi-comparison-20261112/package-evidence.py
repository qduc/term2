from pathlib import Path
import hashlib,json,os,shutil,tarfile
repo=Path.cwd(); output=repo/'.handoff/evidence-package';
if output.exists():shutil.rmtree(output)
output.mkdir()
def copy(source,target):
 target=output/target;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
for p in (repo/'docs/experiments/medium-pi-comparison-20261112').iterdir():
 if p.is_file() and p.suffix in ['.md','.mjs','.py']:copy(p,Path('producer')/p.name)
copy(repo/'.handoff/task-source.tar',Path('task-source.tar'))
for name in ['grading-source','frozen-producer','frozen-v2-producer','frozen-v3-producer','frozen-v3-cap30-producer','frozen-v3-environment-recovery-producer','frozen-v3-second-environment-recovery-producer']:
 for p in (repo/'.handoff'/name).rglob('*'):
  if p.is_file():copy(p,Path(name)/p.relative_to(repo/'.handoff'/name))
for name in ['reference-grade-v6','baseline-grade-v6']:
 for p in (repo/'.handoff'/name).iterdir():
  if p.is_file():copy(p,Path('controls')/name/p.name)
for p in (repo/'.handoff/verifier').rglob('*'):
 if p.is_file() and not any(part in ['grading-copy','node_modules','pnpm-store','store'] or part.startswith('lock-control-') for part in p.relative_to(repo/'.handoff/verifier').parts):
  copy(p,Path('verifier')/p.relative_to(repo/'.handoff/verifier'))
for name in ['campaign','fixture-final','campaign-v2','fixture-cap15','campaign-v3','fixture-cap200','fixture-v3-final']:
 for p in (repo/'.handoff'/name).rglob('*'):
  parts=p.relative_to(repo/'.handoff'/name).parts
  if any(t in ['grading-copy','state','tmp','wire-live'] for t in parts):continue
  if p.is_file():copy(p,Path(name)/p.relative_to(repo/'.handoff'/name))
ledger=repo/'.handoff/campaign-v3/wire-live/ledger.json';copy(ledger,Path('campaign-v3/wire-live/ledger.json'))
copy(repo/'.handoff/v3-initial-ledger.json',Path('campaign-v2/wire-live/ledger.json'))
copy(repo/'.handoff/resume-initial-ledger.json',Path('campaign/wire-live/ledger.json'))
a=json.loads(ledger.read_text())
for e in a:
 if e.get('runId','').startswith('medium-live-'):
  for p in ledger.parent.glob(e['id']+'-*'):copy(p,Path('campaign-v3/wire-live')/p.name)
for name in ['live-driver.txt','fixture-final-driver.txt','network-probe.mjs','network-no-proxy.json','network-with-proxy.json','corrected-launch-probes.txt','direct-launch-refusal.txt','reference-eslint.txt','reference-prettier.txt','controller-install.txt','live-v2-driver.txt','fixture-cap15-driver.txt','cap15-native-probes.txt','live-v3-driver.txt','live-v3-cap30-driver.txt','fixture-v3-final-driver.txt','fixture-cap200-driver.txt','cap30-transition-applied.txt','live-v3-after-environment-restart.txt','live-v3-detached.txt','live-v3-after-thread-404.txt']:
 p=repo/'.handoff'/name
 if p.exists():copy(p,Path('diagnostics')/name)
copy(Path('/workspace/term2/.worktrees/medium-task-base/package.json'),Path('reference-data/base-package.json'))
copy(Path('/workspace/term2/.worktrees/medium-task-reference/scripts/complexity-budget.json'),Path('reference-data/reference-complexity-budget.json'))
copy(Path('/workspace/term2/.worktrees/bare-hillclimb/.handoff/bundles/baseline/build-info.json'),Path('reference-data/term2-build-info.json'))
secrets=[v.encode() for k,v in os.environ.items() if k.endswith(('_API_KEY','_TOKEN','_SECRET')) and len(v)>8]
manifest={}
for p in sorted(output.rglob('*')):
 if p.is_file() and p != output/'evidence-manifest.json':
  data=p.read_bytes()
  if any(key in data for key in secrets):raise RuntimeError('Credential scan rejected evidence; no values printed')
  manifest[str(p.relative_to(output))]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
(output/'evidence-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
archive=repo/'docs/experiments/medium-pi-comparison-20261112/evidence.tar.xz'
with tarfile.open(archive,'w:xz',preset=3) as z:
 for p in sorted(output.rglob('*')):
  if p.is_file():z.add(p,arcname=str(p.relative_to(output)),recursive=False)
receipt={'archive':'evidence.tar.xz','bytes':archive.stat().st_size,'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'files':len(manifest)+1,'knownCredentialScan':'passed','allMediumLiveRequests':sum(e.get('runId','').startswith('medium-live-') for e in a),'unresolvedMediumRequests':sum(e.get('runId','').startswith('medium-live-') and not e.get('priced') for e in a),'completedPrimaryRuns':len(list((repo/'.handoff/campaign-v3/runs').glob('*/result.json')))}
archive.with_name('evidence-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
